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
import { discoverModels } from "../agy/process";
import {
	ACCEPT_EDITS_MODE_ID,
	AUTH_METHOD_ID,
	AVAILABLE_COMMANDS,
	BYPASS_MODE_ID,
	DEFAULT_EFFORT,
	DEFAULT_MODE_ID,
	EFFORT_CONFIG_ID,
	EFFORT_VALUES,
	MODE_CONFIG_ID,
	MODE_VALUES,
	MODEL_CONFIG_ID,
	MODELS_CACHE_FILE,
	PLAN_MODE_ID,
	SANDBOX_CONFIG_ID,
	SKIP_PERMISSIONS_CONFIG_ID,
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
	private availableModels: string[] = [];
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
					this.availableModels = cached;
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
				// Some hosts read a top-level streaming flag (agy-acp parity).
				...({ streaming: true } as object),
				promptCapabilities: {
					embeddedContext: true,
					...({ text: true } as object),
				},
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
		} as InitializeResponse;
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

		// Plan mode is enforced via `agy --mode plan` (see buildAgyArgs).
		const text = promptText(params.prompt);
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

		// ACP PromptResponse stopReason is typically end_turn | cancelled;
		// map internal "error" (already thrown above when message present) away.
		const stopReason =
			outcome.stopReason === "cancelled" ? "cancelled" : "end_turn";
		return { stopReason };
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
		const value = coerceConfigValue(params.value);
		if (!params.configId) {
			throw RequestError.invalidParams(undefined, "missing configId");
		}
		if (!value) throw RequestError.invalidParams(undefined, "missing value");
		const session = await this.requireSession(sessionId);

		switch (params.configId) {
			case MODEL_CONFIG_ID:
				session.modelId = value;
				break;
			case MODE_CONFIG_ID:
				if (!(MODE_VALUES as readonly string[]).includes(value)) {
					throw RequestError.invalidParams(
						undefined,
						`invalid mode '${value}' (valid: ${MODE_VALUES.join(", ")})`,
					);
				}
				session.permissionMode = value;
				// Keep skipPermissions in sync when using the legacy bypass mode value.
				if (value === BYPASS_MODE_ID) session.skipPermissions = true;
				break;
			case EFFORT_CONFIG_ID:
				if (!(EFFORT_VALUES as readonly string[]).includes(value)) {
					throw RequestError.invalidParams(
						undefined,
						`invalid effort '${value}' (valid: ${EFFORT_VALUES.join(", ")})`,
					);
				}
				session.effort = value;
				break;
			case SANDBOX_CONFIG_ID: {
				const on = parseOnOff(value);
				if (on === null) {
					throw RequestError.invalidParams(
						undefined,
						`invalid sandbox '${value}' (valid: off, on)`,
					);
				}
				session.sandbox = on;
				break;
			}
			case SKIP_PERMISSIONS_CONFIG_ID: {
				const on = parseOnOff(value);
				if (on === null) {
					throw RequestError.invalidParams(
						undefined,
						`invalid skip_permissions '${value}' (valid: off, on)`,
					);
				}
				session.skipPermissions = on;
				break;
			}
			default:
				throw RequestError.invalidParams(
					undefined,
					`unknown configId: ${params.configId}`,
				);
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

		// Order matches agy-acp priority: mode, model, effort, sandbox, skip_permissions.
		const pm = session.permissionMode;
		const currentMode =
			pm === BYPASS_MODE_ID
				? BYPASS_MODE_ID
				: pm === PLAN_MODE_ID
					? PLAN_MODE_ID
					: pm === ACCEPT_EDITS_MODE_ID
						? ACCEPT_EDITS_MODE_ID
						: DEFAULT_MODE_ID;

		options.push({
			id: MODE_CONFIG_ID,
			name: "Mode",
			description: "Controls how the agent applies edits and requests review",
			category: "mode",
			type: "select",
			currentValue: currentMode,
			options: [
				{
					value: DEFAULT_MODE_ID,
					name: "Default",
					description: "Request review before applying file writes",
				},
				{
					value: ACCEPT_EDITS_MODE_ID,
					name: "Accept Edits",
					description: "Apply file edits automatically",
				},
				{
					value: PLAN_MODE_ID,
					name: "Plan",
					description: "Plan without applying edits (agy --mode plan)",
				},
				{
					value: BYPASS_MODE_ID,
					name: "Skip Permissions (legacy)",
					description:
						"Legacy alias for enabling skip-permissions; prefer the Skip Permissions toggle",
				},
			],
		});

		if (models.length > 0) {
			const currentModel =
				session.modelId ?? models[0] ?? "Gemini 3.5 Flash (Medium)";
			options.push({
				id: MODEL_CONFIG_ID,
				name: "Model",
				description: "Model used for this session",
				category: "model",
				type: "select",
				currentValue: currentModel,
				options: models.map((name) => ({ value: name, name })),
			});
		}

		options.push({
			id: EFFORT_CONFIG_ID,
			name: "Effort",
			description: "Reasoning effort / thinking level",
			category: "thought_level",
			type: "select",
			currentValue: session.effort || DEFAULT_EFFORT,
			options: [
				{ value: "low", name: "Low", description: "Faster, less deliberation" },
				{
					value: "medium",
					name: "Medium",
					description: "Balanced reasoning effort",
				},
				{ value: "high", name: "High", description: "Deeper reasoning" },
			],
		});

		options.push({
			id: SANDBOX_CONFIG_ID,
			name: "Sandbox",
			description: "Run tool commands in the OS sandbox",
			category: "_safety",
			type: "select",
			currentValue: session.sandbox ? "on" : "off",
			options: [
				{ value: "off", name: "Off", description: "Disabled" },
				{ value: "on", name: "On", description: "Enabled" },
			],
		});

		options.push({
			id: SKIP_PERMISSIONS_CONFIG_ID,
			name: "Skip Permissions",
			description: "Auto-approve all tool permission requests (dangerous)",
			category: "_safety",
			type: "select",
			currentValue: session.skipPermissions ? "on" : "off",
			options: [
				{ value: "off", name: "Off", description: "Disabled" },
				{ value: "on", name: "On", description: "Enabled" },
			],
		});

		return options;
	}
}

function coerceConfigValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "boolean") return value ? "on" : "off";
	return "";
}

function parseOnOff(value: string): boolean | null {
	switch (value) {
		case "on":
		case "true":
		case "1":
			return true;
		case "off":
		case "false":
		case "0":
			return false;
		default:
			return null;
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
