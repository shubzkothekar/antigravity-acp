// ACP method surface for the agy agent: session lifecycle, prompting, history
// replay, model/permission configuration.

import * as fs from "node:fs";
import type {
	AuthenticateResponse,
	CloseSessionResponse,
	DeleteSessionResponse,
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
import { type DiscoveredModel, discoverModels, runNonInteractivePrompt } from "../agy/process";
import { formatUsageOutput } from "../agy/usage-format";
import {
	AUTH_METHOD_ID,
	AVAILABLE_COMMANDS,
	BYPASS_MODE_ID,
	DEFAULT_MODE_ID,
	MODE_CONFIG_ID,
	MODEL_CONFIG_ID,
	MODELS_CACHE_FILE,
	PLAN_MODE_ID,
	PLAN_MODE_INJECTION,
	STATE_DIR,
} from "../constants";
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
}

type Json = Record<string, unknown>;

interface ConfigResult {
	configOptions: SessionConfigOption[];
}

export class AgyAcpAgent {
	private readonly sessions: SessionManager;
	private readonly adapter: Adapter;
	private readonly replayCache = new ReplayCache();
	private availableModels: DiscoveredModel[] = [];
	// Tracks which AcpClient is serving each session so async updates can be pushed.
	private readonly activeClients = new Map<string, AcpClient>();

	constructor(private readonly config: AgentConfig) {
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

	initialize(): InitializeResponse {
		return {
			protocolVersion: 1,
			agentInfo: { name: "Antigravity", version: this.config.version },
			agentCapabilities: {
				loadSession: true,
				promptCapabilities: { embeddedContext: true },
				sessionCapabilities: {
					list: {},
					delete: {},
					resume: {},
					close: {},
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
		params: { cwd?: string; additionalDirectories?: string[] },
		client: AcpClient,
	): NewSessionResponse {
		const cwd = params.cwd || this.config.workingDir;
		const additionalDirs = params.additionalDirectories ?? [];
		const { sessionId, session } = this.sessions.create(cwd, additionalDirs);
		this.activeClients.set(sessionId, client);
		this.announceSession(client, sessionId, session);
		return { sessionId, ...this.configResult(session) };
	}

	async loadSession(
		params: {
			sessionId?: string;
			cwd?: string;
			additionalDirectories?: string[];
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

		this.activeClients.set(sessionId, client);
		this.announceSession(client, sessionId, session);
		return this.configResult(session);
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
		return {};
	}

	/** Close a session: cancel any in-flight prompt and free in-memory state. */
	closeSession(params: { sessionId?: string }): CloseSessionResponse {
		const sessionId = params.sessionId;
		if (sessionId) {
			this.adapter.cancel(sessionId);
			this.sessions.evict(sessionId);
			this.activeClients.delete(sessionId);
		}
		return {};
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

		const text =
			session.permissionMode === PLAN_MODE_ID
				? PLAN_MODE_INJECTION + rawText
				: rawText;
		const outcome = await this.adapter.runPrompt(
			sessionId,
			session,
			text,
			client,
		);

		if (outcome.error)
			throw RequestError.internalError(undefined, outcome.error);

		if (session.conversationId === null) {
			session.conversationId = outcome.conversationId;
		}
		if (outcome.conversationId !== null) {
			session.lastStepIdx = outcome.lastStepIdx;
			session.updatedAt = new Date().toISOString();
			await this.sessions.persist(sessionId, session);
		}

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
		const value = typeof params.value === "string" ? params.value : "";
		if (
			params.configId !== MODEL_CONFIG_ID &&
			params.configId !== MODE_CONFIG_ID
		) {
			throw RequestError.invalidParams(
				undefined,
				`unknown configId: ${params.configId}`,
			);
		}
		if (!value) throw RequestError.invalidParams(undefined, "missing value");
		const session = await this.requireSession(sessionId);
		if (params.configId === MODEL_CONFIG_ID) {
			session.modelId = value;
		} else if (params.configId === MODE_CONFIG_ID) {
			session.permissionMode = value;
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

		const pm = session.permissionMode;
		const currentMode =
			pm === BYPASS_MODE_ID
				? BYPASS_MODE_ID
				: pm === PLAN_MODE_ID
					? PLAN_MODE_ID
					: DEFAULT_MODE_ID;

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
					description: "Antigravity's standard mode",
				},
				{
					value: PLAN_MODE_ID,
					name: "Plan Mode",
					description:
						"Read-only exploration: agent may only read and search, then returns " +
						"a step-by-step plan without making any changes",
				},
				{
					value: BYPASS_MODE_ID,
					name: "Skip Permissions",
					description:
						"Run without permission prompts — use with caution, as this may allow the agent to make changes without confirmation",
				},
			],
		});

		return options;
	}
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
