// ACP method surface for the agy agent: session lifecycle, prompting, history
// replay, model/permission configuration.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	AuthenticateResponse,
	CloseSessionResponse,
	DeleteSessionResponse,
	ForkSessionResponse,
	InitializeResponse,
	ListSessionsResponse,
	LoadSessionResponse,
	LogoutResponse,
	NewSessionResponse,
	PromptResponse,
	ResumeSessionResponse,
	SessionConfigOption,
	SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import { SessionMcpPlugins, stdioServers } from "../agy/mcp";
import { type DiscoveredModel, discoverModels, runNonInteractivePrompt } from "../agy/process";
import { formatUsageOutput } from "../agy/usage-format";
import {
	AUTH_METHOD_ID,
	AVAILABLE_COMMANDS,
	DEFAULT_MODE_ID,
	MODE_CONFIG_ID,
	MODEL_CONFIG_ID,
	MODELS_CACHE_FILE,
	PLAN_MODE_ID,
	SANDBOX_CONFIG_ID,
	STATE_DIR,
} from "../constants";
import { forkConversation } from "../conversation/fork";
import { ReplayCache } from "../conversation/replay";
import { SessionStore } from "../store/sessionStore";
import { newSession, type Session } from "../types/session";
import { Adapter } from "./adapter";
import type { AcpClient } from "./client";
import { SessionManager } from "./sessions";

export interface AgentConfig {
	binary: string;
	conversationsDir: string;
	workingDir: string;
	skipNarration: boolean;
	version: string;
	/** Where per-session MCP plugin folders go (default MCP_SESSIONS_DIR in agy/mcp.ts). */
	mcpSessionsDir?: string;
}

type Json = Record<string, unknown>;

interface ConfigResult {
	configOptions: SessionConfigOption[];
}

const DEFAULT_MODELS: DiscoveredModel[] = [
	{ value: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)" },
	{ value: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
];

export class AgyAcpAgent {
	private readonly sessions: SessionManager;
	private readonly adapter: Adapter;
	private readonly replayCache = new ReplayCache();
	private availableModels: DiscoveredModel[] = [];
	// Tracks which AcpClient is serving each session so async updates can be pushed.
	private readonly activeClients = new Map<string, AcpClient>();
	// Per-session plugin folders carrying each session's MCP servers to agy.
	// In memory only: the servers' env holds client tokens, so they are never
	// written to sessions.json; clients resend them on session/load|resume.
	private readonly mcp: SessionMcpPlugins;

	constructor(private readonly config: AgentConfig) {
		this.mcp = new SessionMcpPlugins(config.mcpSessionsDir);
		this.mcp.sweepStale();
		this.sessions = new SessionManager(new SessionStore());
		this.adapter = new Adapter({
			binary: config.binary,
			conversationsDir: config.conversationsDir,
			workingDir: config.workingDir,
			skipNarration: config.skipNarration,
		});
		// Attempt to load models from cache immediately for fast startup.
		try {
			if (fs.existsSync(MODELS_CACHE_FILE)) {
				const cached = JSON.parse(fs.readFileSync(MODELS_CACHE_FILE, "utf-8"));
				if (Array.isArray(cached) && cached.length > 0) {
					// Normalize cached items to DiscoveredModel structure for backwards compatibility with legacy string[] cache files.
					this.availableModels = cached.map((item: any) =>
						typeof item === "string" ? { value: item, name: item } : item,
					);
				}
			}
		} catch {
			// ignore
		}

		// Save initial default models cache if missing
		try {
			if (!fs.existsSync(MODELS_CACHE_FILE)) {
				fs.mkdirSync(STATE_DIR, { recursive: true });
				fs.writeFileSync(MODELS_CACHE_FILE, JSON.stringify(this.availableModels));
			}
		} catch {
			// ignore
		}

		// Kick off model discovery in the background; update cache and push
		// config_option_update to all active sessions if the list changes.
		discoverModels(config.binary).then((models) => {
			const changed =
				JSON.stringify(models) !== JSON.stringify(this.availableModels);
			if (changed && models.length > 0) {
				this.availableModels = models;
				this.pushConfigOptionUpdates();
				try {
					fs.mkdirSync(STATE_DIR, { recursive: true });
					fs.writeFileSync(MODELS_CACHE_FILE, JSON.stringify(models));
				} catch {
					// ignore
				}
			}
		});
	}

	// --- ACP methods ---------------------------------------------------------

	listModels() {
		const models = this.availableModels.length > 0 ? this.availableModels : DEFAULT_MODELS;
		return {
			models: models.map((m) => ({
				id: m.value,
				name: m.name,
				description: `Google Antigravity ${m.name}`,
			})),
			currentModelId: models[0]?.value,
		};
	}

	initialize(): InitializeResponse {
		return {
			protocolVersion: 1,
			agentInfo: { name: "Antigravity", version: this.config.version },
			agentCapabilities: {
				loadSession: true,
				// `image: true` because promptText() already writes attached images to a
				// private temp file and directs agy's view_file tool at it (see writeImage
				// below). `audio` stays unset: agy has no equivalent ingestion path yet.
				promptCapabilities: { image: true, embeddedContext: true },
				// Session MCP servers reach agy through a per-session plugin
				// (agy/mcp.ts). Only stdio servers are passed on for now.
				mcpCapabilities: { http: false, sse: false },
				sessionCapabilities: {
					list: {},
					delete: {},
					resume: {},
					close: {},
					// Fork clones the agy conversation DB under a new id (see
					// conversation/fork.ts); only whole-session (tip) forks.
					fork: {},
					additionalDirectories: {},
				},
				auth: { logout: {} },
			},
			authMethods: [
				{
					id: AUTH_METHOD_ID,
					name: "Google Sign In",
					description:
						"Antigravity uses Google OAuth2 credentials managed by the agy CLI. " +
						"Run `agy` to configure authentication if needed.",
				},
			],
		};
	}

	/** ACP authenticate — verify agy binary is accessible (credentials managed by agy). */
	authenticate(params: { methodId?: string }): AuthenticateResponse {
		if (params.methodId && params.methodId !== AUTH_METHOD_ID) {
			throw RequestError.invalidParams(
				undefined,
				`unknown auth method: ${params.methodId}`,
			);
		}
		return {};
	}

	/** ACP logout — no-op since agy manages its own OAuth state. */
	logout(): LogoutResponse {
		return {};
	}

	newSession(
		params: {
			cwd?: string;
			additionalDirectories?: string[];
			mcpServers?: unknown;
		},
		client: AcpClient,
	): NewSessionResponse {
		const cwd = params.cwd || this.config.workingDir;
		const additionalDirs = params.additionalDirectories ?? [];
		const { sessionId, session } = this.sessions.create(cwd, additionalDirs);
		this.applyMcpServers(sessionId, params.mcpServers);
		this.activeClients.set(sessionId, client);
		this.announceSession(client, sessionId, session);
		return { sessionId, ...this.configResult(session) };
	}

	async loadSession(
		params: {
			sessionId?: string;
			cwd?: string;
			additionalDirectories?: string[];
			mcpServers?: unknown;
		},
		client: AcpClient,
	): Promise<LoadSessionResponse> {
		const sessionId = this.requireSessionId(params.sessionId);
		const session = await this.sessions.ensure(sessionId);
		if (!session) throw RequestError.resourceNotFound(sessionId);

		if (params.cwd && params.cwd !== session.cwd) {
			session.cwd = params.cwd;
		}
		if (params.additionalDirectories) {
			session.additionalDirs = params.additionalDirectories;
		}
		this.applyMcpServers(sessionId, params.mcpServers);

		if (session.conversationId) {
			const replay = this.replayCache.get(
				this.config.conversationsDir,
				session.conversationId,
				{ skipNarration: this.config.skipNarration, cwd: session.cwd },
			);
			if (replay && replay.updates.length > 0) {
				for (const update of replay.updates) {
					await client.update(sessionId, update);
				}
				session.lastStepIdx = replay.maxIdx;
				await this.sessions.persist(sessionId, session);
			}
		}

		this.activeClients.set(sessionId, client);
		this.announceSession(client, sessionId, session);
		return this.configResult(session);
	}

	async resumeSession(
		params: {
			sessionId?: string;
			cwd?: string;
			additionalDirectories?: string[];
			mcpServers?: unknown;
		},
		client: AcpClient,
	): Promise<ResumeSessionResponse> {
		const sessionId = this.requireSessionId(params.sessionId);
		const session = await this.sessions.ensure(sessionId);
		if (!session) throw RequestError.resourceNotFound(sessionId);

		let dirty = false;
		if (params.cwd && params.cwd !== session.cwd) {
			session.cwd = params.cwd;
			dirty = true;
		}
		if (params.additionalDirectories) {
			session.additionalDirs = params.additionalDirectories;
			dirty = true;
		}
		if (dirty) await this.sessions.persist(sessionId, session);
		this.applyMcpServers(sessionId, params.mcpServers);

		this.activeClients.set(sessionId, client);
		this.announceSession(client, sessionId, session);
		return this.configResult(session);
	}

	/**
	 * ACP session/fork (unstable): start a new session that carries the source's
	 * history. agy cannot fork natively, so the source conversation DB is cloned
	 * under a fresh id and the new session resumes that clone. History is not
	 * replayed; the client already has the source timeline.
	 */
	async forkSession(
		params: {
			sessionId?: string;
			cwd?: string;
			additionalDirectories?: string[];
			mcpServers?: unknown;
		},
		client: AcpClient,
	): Promise<ForkSessionResponse> {
		const sourceId = this.requireSessionId(params.sessionId);
		const source = await this.sessions.ensure(sourceId);
		if (!source) throw RequestError.resourceNotFound(sourceId);

		let conversationId: string | null = null;
		let lastStepIdx = -1;
		if (source.conversationId) {
			try {
				const forked = forkConversation(
					this.config.conversationsDir,
					source.conversationId,
				);
				conversationId = forked.conversationId;
				lastStepIdx = forked.lastStepIdx;
			} catch (err) {
				throw RequestError.internalError(
					undefined,
					`could not fork agy conversation: ${(err as Error).message}`,
				);
			}
		}

		const cwd = params.cwd || source.cwd || this.config.workingDir;
		const { sessionId, session } = this.sessions.create(
			cwd,
			params.additionalDirectories ?? source.additionalDirs,
		);
		session.conversationId = conversationId;
		session.lastStepIdx = lastStepIdx;
		session.modelId = source.modelId;
		session.permissionMode = source.permissionMode;
		session.sandbox = source.sandbox;
		session.title = source.title;
		await this.sessions.persist(sessionId, session);
		// The fork's own servers, not the source's: a client's servers can carry
		// per-session credentials.
		this.applyMcpServers(sessionId, params.mcpServers);

		this.activeClients.set(sessionId, client);
		this.announceSession(client, sessionId, session);
		return { sessionId, ...this.configResult(session) };
	}

	/** List all known sessions. */
	async listSessions(params: { cwd?: string }): Promise<ListSessionsResponse> {
		const all = await this.sessions.list();
		const sessions = all
			.filter((entry) => !params.cwd || entry.session.cwd === params.cwd)
			.map((entry) => ({
				sessionId: entry.sessionId,
				cwd: entry.session.cwd || this.config.workingDir,
				title: entry.session.title ?? null,
				updatedAt: entry.session.updatedAt ?? null,
			}));
		return { sessions };
	}

	/** Delete a session from persistent storage. */
	async deleteSession(params: {
		sessionId?: string;
	}): Promise<DeleteSessionResponse> {
		const sessionId = this.requireSessionId(params.sessionId);
		const deleted = await this.sessions.delete(sessionId);
		if (!deleted) throw RequestError.resourceNotFound(sessionId);
		this.activeClients.delete(sessionId);
		this.removeMcpServers(sessionId);
		return {};
	}

	/** Close a session: cancel any in-flight prompt and free in-memory state. */
	closeSession(params: { sessionId?: string }): CloseSessionResponse {
		const sessionId = params.sessionId;
		if (sessionId) {
			this.adapter.cancel(sessionId);
			this.sessions.evict(sessionId);
			this.activeClients.delete(sessionId);
			this.removeMcpServers(sessionId);
		}
		return {};
	}

	/** Remove every per-session MCP folder this process wrote (on shutdown). */
	dispose(): void {
		this.mcp.removeAll();
	}

	/** Record the MCP servers a client sent for a session. `undefined` (the
	 *  field left out) keeps what the session had; a list, even an empty one,
	 *  replaces it. Failing to write them is logged, not fatal: the session
	 *  still works, only without those tools. */
	private applyMcpServers(sessionId: string, mcpServers: unknown): void {
		if (mcpServers === undefined) return;
		try {
			this.mcp.set(sessionId, stdioServers(mcpServers));
		} catch (err) {
			console.error(
				`[agy-acp] could not pass MCP servers to agy for ${sessionId}:`,
				(err as Error).message,
			);
		}
	}

	private removeMcpServers(sessionId: string): void {
		try {
			this.mcp.remove(sessionId);
		} catch {
			// best effort; the next start sweeps what is left
		}
	}

	/** The session's plugin folder for this turn; a failure to (re)write it
	 *  costs the turn its MCP tools, not the turn itself. */
	private mcpRootFor(sessionId: string): string | null {
		try {
			return this.mcp.root(sessionId);
		} catch (err) {
			console.error(
				`[agy-acp] could not pass MCP servers to agy for ${sessionId}:`,
				(err as Error).message,
			);
			return null;
		}
	}

	async prompt(
		params: { sessionId?: string; prompt?: unknown },
		client: AcpClient,
	): Promise<PromptResponse> {
		const sessionId = this.requireSessionId(params.sessionId);

		let session = await this.sessions.ensure(sessionId);
		if (!session) {
			// Unknown session: create a fresh binding so prompts still work.
			session = newSession(this.config.workingDir);
			this.sessions.adopt(sessionId, session);
		}

		const rawText = promptText(params.prompt);
		const userText = rawPromptText(params.prompt).trim();
		if (userText === "/usage" || userText.startsWith("/usage ")) {
			const output = await runNonInteractivePrompt(
				this.config.binary,
				"/usage",
				session.cwd,
			);
			await client.update(sessionId, {
				sessionUpdate: "agent_message_chunk",
				content: {
					type: "text",
					text: output ? formatUsageOutput(output) : "No usage data available.",
				},
			});
			return { stopReason: "end_turn" };
		}

		const outcome = await this.adapter.runPrompt(
			sessionId,
			session,
			rawText,
			client,
			this.mcpRootFor(sessionId),
		);

		// Record the steps even when the turn failed, so the next prompt does not
		// re-read them (e.g. a stale 429 after the quota has reset).
		if (session.conversationId === null) {
			session.conversationId = outcome.conversationId;
		}
		if (outcome.conversationId !== null) {
			session.lastStepIdx = outcome.lastStepIdx;
			session.updatedAt = new Date().toISOString();
			await this.sessions.persist(sessionId, session);
		}

		if (outcome.error)
			throw RequestError.internalError(undefined, outcome.error);

		return { stopReason: outcome.stopReason };
	}

	cancel(params: { sessionId?: string }): void {
		if (params.sessionId) this.adapter.cancel(params.sessionId);
	}

	/** SDK-native config setter (session/set_config_option). */
	async setConfigOption(params: {
		sessionId?: string;
		configId?: string;
		value?: unknown;
	}): Promise<SetSessionConfigOptionResponse> {
		const sessionId = this.requireSessionId(params.sessionId);
		if (
			params.configId !== MODEL_CONFIG_ID &&
			params.configId !== MODE_CONFIG_ID &&
			params.configId !== SANDBOX_CONFIG_ID
		) {
			throw RequestError.invalidParams(
				undefined,
				`unknown configId: ${params.configId}`,
			);
		}
		const session = await this.requireSession(sessionId);
		if (params.configId === SANDBOX_CONFIG_ID) {
			if (typeof params.value !== "boolean") {
				throw RequestError.invalidParams(
					undefined,
					"sandbox value must be a boolean",
				);
			}
			session.sandbox = params.value;
		} else {
			const value = typeof params.value === "string" ? params.value : "";
			if (!value) throw RequestError.invalidParams(undefined, "missing value");
			if (params.configId === MODEL_CONFIG_ID) {
				session.modelId = value;
			} else if (params.configId === MODE_CONFIG_ID) {
				session.permissionMode = value;
			}
		}
		await this.sessions.persist(sessionId, session);
		return { configOptions: this.configOptions(session) };
	}

	listResources(): Json {
		return { resources: [] };
	}
	listPrompts(): Json {
		return { prompts: [] };
	}
	listTools(): Json {
		return { tools: [] };
	}

	// --- helpers -------------------------------------------------------------

	private requireSessionId(sessionId: string | undefined): string {
		if (!sessionId) {
			throw RequestError.invalidParams(undefined, "missing sessionId");
		}
		return sessionId;
	}

	private async requireSession(sessionId: string): Promise<Session> {
		const session = await this.sessions.ensure(sessionId);
		if (!session) throw RequestError.resourceNotFound(sessionId);
		return session;
	}

	/** Push config_option_update to every active session once models are known. */
	private pushConfigOptionUpdates(): void {
		for (const [sessionId, client] of this.activeClients) {
			void this.sessions.ensure(sessionId).then((session) => {
				if (!session) return;
				const opts = this.configOptions(session);
				if (opts.length === 0) return;
				void client
					.update(sessionId, {
						sessionUpdate: "config_option_update",
						configOptions: opts,
					} as never)
					.catch(() => {});
			});
		}
	}

	/** Send post-response notifications: commands, current mode, and config options (if ready). */
	private announceSession(
		client: AcpClient,
		sessionId: string,
		session: Session,
	): void {
		setTimeout(async () => {
			await client
				.update(sessionId, {
					sessionUpdate: "available_commands_update",
					availableCommands: AVAILABLE_COMMANDS,
				} as never)
				.catch(() => {});

			// Push config options if model discovery already finished.
			const opts = this.configOptions(session);
			if (opts.length > 0) {
				await client
					.update(sessionId, {
						sessionUpdate: "config_option_update",
						configOptions: opts,
					} as never)
					.catch(() => {});
			}
		}, 50);
	}

	private configResult(session: Session): ConfigResult {
		return {
			configOptions: this.configOptions(session),
		};
	}

	private configOptions(session: Session): SessionConfigOption[] {
		const options: SessionConfigOption[] = [];
		const models = this.availableModels;

		if (models.length > 0) {
			const currentModel =
				session.modelId ?? models[0]?.value ?? "gemini-3.6-flash-medium";
			options.push({
				id: MODEL_CONFIG_ID,
				name: "Model",
				category: "model",
				type: "select",
				currentValue: currentModel,
				options: models.map((m) => ({ value: m.value, name: m.name })),
			});
		}

		const currentMode =
			session.permissionMode === PLAN_MODE_ID ? PLAN_MODE_ID : DEFAULT_MODE_ID;

		options.push({
			id: MODE_CONFIG_ID,
			name: "Mode",
			category: "mode",
			type: "select",
			currentValue: currentMode,
			options: [
				{
					value: DEFAULT_MODE_ID,
					name: "Standard",
					description: "Antigravity's standard mode (agy --mode accept-edits)",
				},
				{
					value: PLAN_MODE_ID,
					name: "Plan Mode",
					description:
						"Read-only exploration: agent may only read and search, then returns " +
						"a step-by-step plan without making any changes (agy --mode plan)",
				},
			],
		});

		options.push({
			id: SANDBOX_CONFIG_ID,
			name: "Sandbox",
			category: "security",
			type: "boolean",
			currentValue: session.sandbox ?? false,
			description: "Run in a sandbox with terminal restrictions enabled",
		});

		return options;
	}
}

/** Write a base64 image to a new temp file readable only by the current user.
 *  The extension comes from the client's mimeType, so only plain alphanumerics
 *  are accepted; anything else could escape the temp dir or alter the prompt. */
function writeImage(data: string, mimeType: unknown): string {
	const subtype = typeof mimeType === "string" ? mimeType.split("/")[1] : "";
	const ext = subtype && /^[a-z0-9]{1,10}$/i.test(subtype) ? subtype : "png";
	const tmpPath = path.join(
		os.tmpdir(),
		`agy_acp_img_${crypto.randomUUID()}.${ext}`,
	);
	fs.writeFileSync(tmpPath, Buffer.from(data, "base64"), {
		mode: 0o600,
		flag: "wx",
	});
	return tmpPath;
}

function escapeAttr(str: string): string {
	return str.replace(/"/g, "&quot;");
}

/** Flatten an ACP prompt (text / resource / context blocks) into a string. */
function promptText(prompt: unknown): string {
	const blocks = Array.isArray(prompt) ? prompt : [];
	const parts: string[] = [];
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		const obj = block as Record<string, unknown>;
		const type = obj.type;

		if (type === "text" && typeof obj.text === "string") {
			// Text block — the plain user message content.
			parts.push(`<user_text>\n${obj.text}\n</user_text>`);
		} else if (type === "resource_link") {
			// Resource link — reference by URI; include the link so agy is aware of it.
			const uri = typeof obj.uri === "string" ? obj.uri : "unknown";
			const label =
				typeof obj.title === "string"
					? obj.title
					: typeof obj.name === "string"
						? obj.name
						: uri;
			parts.push(
				`<resource_link uri="${escapeAttr(uri)}" title="${escapeAttr(label)}"/>`,
			);
		} else if (
			type === "resource" &&
			obj.resource &&
			typeof obj.resource === "object"
		) {
			// Embedded resource — inline the text content if present.
			const r = obj.resource as Record<string, unknown>;
			const uri = typeof r.uri === "string" ? r.uri : "unknown";
			const text = stringField(r, "text", "content");
			if (text)
				parts.push(
					`<embedded_resource uri="${escapeAttr(uri)}">\n${text}\n</embedded_resource>`,
				);
		} else if (type === "image" && typeof obj.data === "string") {
			// Image — agy only takes text, so write the image to a private temp
			// file and point the model at it.
			parts.push(
				`\n[User attached an image file. Absolute path: ${writeImage(obj.data, obj.mimeType)}. You must use your view_file tool on this path to see it.]\n`,
			);
		} else if (typeof obj.text === "string") {
			// Fallback: treat any block with a text field as plain text.
			parts.push(`<user_text>\n${obj.text}\n</user_text>`);
		}
	}
	return parts.join("\n\n").trim();
}

function stringField(obj: Record<string, unknown>, ...keys: string[]): string {
	for (const key of keys) {
		if (typeof obj[key] === "string") return obj[key] as string;
	}
	return "";
}

/** Extract raw user text from ACP prompt blocks without XML tag formatting. */
function rawPromptText(prompt: unknown): string {
	const blocks = Array.isArray(prompt) ? prompt : [];
	const parts: string[] = [];
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		const obj = block as Record<string, unknown>;
		if (typeof obj.text === "string") {
			parts.push(obj.text);
		}
	}
	return parts.join("\n").trim();
}
