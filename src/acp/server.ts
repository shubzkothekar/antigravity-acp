// Wire Bun's stdio to the ACP connection and dispatch to AgyAcpAgent.

import { agent, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import pkg from "../../package.json";
import { resolveAgyBinary } from "../agy/binary";
import { CONVERSATION_DIR } from "../constants";
import { AgyAcpAgent } from "./agent";
import { AcpClient } from "./client";

/** A WritableStream backed by Bun's stdout sink (the ACP wire to the client). */
function stdoutWritable(): WritableStream<Uint8Array> {
	const sink = Bun.stdout.writer();
	return new WritableStream<Uint8Array>({
		write(chunk) {
			sink.write(chunk);
			sink.flush();
		},
		close() {
			sink.end();
		},
	});
}

/** Identity parser for raw (non-builtin) ACP methods. */
const raw = <T>() => ({ parse: (p: unknown) => p as T });

export function runAcp() {
	const skipNarration = process.argv.includes("--skip-narration");

	const agentImpl = new AgyAcpAgent({
		binary: resolveAgyBinary(),
		conversationsDir: CONVERSATION_DIR,
		workingDir: process.cwd(),
		skipNarration,
		version: pkg.version ?? "0.0.0",
	});

	// ndJsonStream(writableToClient, readableFromClient) — both native Web streams.
	const stream = ndJsonStream(stdoutWritable(), Bun.stdin.stream());

	const connection = agent({ name: "agy-acp" })
		.onRequest(methods.agent.initialize, () => agentImpl.initialize())
		.onRequest(methods.agent.authenticate, (ctx) =>
			agentImpl.authenticate(ctx.params as { methodId?: string }),
		)
		.onRequest(methods.agent.logout, () => agentImpl.logout())
		.onRequest(methods.agent.session.new, (ctx) =>
			agentImpl.newSession(
				ctx.params as { cwd?: string; additionalDirectories?: string[] },
				new AcpClient(ctx.client),
			),
		)
		.onRequest(methods.agent.session.load, (ctx) =>
			agentImpl.loadSession(
				ctx.params as {
					sessionId?: string;
					cwd?: string;
					additionalDirectories?: string[];
				},
				new AcpClient(ctx.client),
			),
		)
		.onRequest(methods.agent.session.resume, (ctx) =>
			agentImpl.resumeSession(
				ctx.params as {
					sessionId?: string;
					cwd?: string;
					additionalDirectories?: string[];
				},
				new AcpClient(ctx.client),
			),
		)
		.onRequest(methods.agent.session.list, (ctx) =>
			agentImpl.listSessions(ctx.params as { cwd?: string }),
		)
		.onRequest(methods.agent.session.delete, (ctx) =>
			agentImpl.deleteSession(ctx.params as { sessionId?: string }),
		)
		.onRequest(methods.agent.session.close, (ctx) =>
			agentImpl.closeSession(ctx.params as { sessionId?: string }),
		)
		.onRequest(methods.agent.session.prompt, (ctx) =>
			agentImpl.prompt(ctx.params, new AcpClient(ctx.client)),
		)
		.onRequest(methods.agent.session.setConfigOption, (ctx) =>
			agentImpl.setConfigOption(ctx.params),
		)
		// Custom endpoint — not part of the ACP spec. Lets clients discover
		// available models for the session/setConfigOption "model" option.
		.onRequest("models/list", raw<unknown>(), () =>
			agentImpl.listModels(),
		)
		.onRequest("resources/list", raw<unknown>(), () =>
			agentImpl.listResources(),
		)
		.onRequest("prompts/list", raw<unknown>(), () => agentImpl.listPrompts())
		.onRequest("tools/list", raw<unknown>(), () => agentImpl.listTools())
		.onNotification(methods.agent.session.cancel, (ctx) =>
			agentImpl.cancel(ctx.params),
		)
		.connect(stream);

	return { connection, agent: agentImpl };
}
