# Antigravity ACP Server

An [Agent Client Protocol](https://agentclientprotocol.com) (ACP) server for
Google Antigravity's `agy` CLI, built on [Bun](https://bun.com). It lets any
ACP-compatible editor drive `agy`: it keeps one interactive CLI process per ACP
session, streams its progress live, and replays conversation history on demand.

## ⚠️ Terms of Service risk

Google's [Antigravity Terms of Service](https://antigravity.google/terms) state:

> You must not abuse, harm, interfere with, or disrupt the Service. This
> includes, but is not limited to, using the Service in connection with
> products not provided by us. Using third party software, tools, or services
> to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a
> breach of this Agreement. Such actions may be grounds for suspension or
> termination of your account.

`antigravity-acp` does not itself request, store, or process any
authentication credentials — it only spawns the official `agy` binary as a
subprocess and drives it through a local pseudo-terminal; all Google OAuth
login is handled entirely by `agy` itself, outside of this project. However, the *effect* is
still a non-Google, ACP-compatible editor driving `agy` (and therefore your
Antigravity account) through a third-party tool — the exact pattern Google's
FAQ names as a Terms of Service violation (Claude Code, OpenClaw, OpenCode,
and by extension this project).

**By using `antigravity-acp` with an `agy` session logged into your personal
Antigravity account, you accept the risk that Google may suspend or terminate
that account.** This project is provided as-is, with no warranty, and its
authors and contributors accept no liability for any account action Google
takes as a result of its use. If you want to avoid this risk entirely, Google
recommends authenticating with a Vertex AI or AI Studio API key instead of an
Antigravity OAuth login.

See [#3](https://github.com/shubzkothekar/antigravity-acp/issues/3) for
background.

## Run

**From source (Bun required):**

```bash
bun run index.ts          # ACP over stdio
bun run index.ts --version
```

**As a compiled single-executable (no Bun required):**

```bash
dist/agy-acp-darwin-arm64   # macOS Apple Silicon
dist/agy-acp-darwin-x64     # macOS Intel
dist/agy-acp-linux-arm64    # Linux ARM64
dist/agy-acp-linux-x64      # Linux x86-64
dist/agy-acp-windows-arm64.exe # Windows ARM64
dist/agy-acp-windows-x64.exe   # Windows x86-64
```

Both modes speak ACP over stdio — point your editor at the binary as-is.

## agy auto-install

The server locates `agy` at startup using this priority order:

1. An `agy` binary placed next to the executable (`dist/agy`, or `bin/agy` when
   running from source after `bun install`).
2. `$AGY_BIN` — set this to point at your own build.
3. `agy` on `$PATH`.

If none are found the server downloads the matching release from GitHub
(`google-antigravity/antigravity-cli`) and verifies its SHA-256. The download is
skipped when `AGY_SKIP_DOWNLOAD=1` or `$AGY_BIN` is set.

`bun install` runs the same download via the `postinstall` hook, so a plain
`bun install` also provisions `agy` for source runs.

## Flags / env

| | |
|---|---|
| `AGY_BIN` | Path to an `agy` binary; skips the auto-download |
| `AGY_SKIP_DOWNLOAD` | Set to `1` to skip the download entirely |
| `AGY_EXTRA_ARGS` | Extra args forwarded to every `agy` invocation |
| `AGY_CONVERSATIONS_DIR` | Custom directory where `agy` writes its conversation SQLite databases |
| `AGY_PERSISTENT` | Persistent interactive sessions are enabled by default; set to `0` to use one process per prompt |
| `AGY_PROMPT_TIMEOUT_MS` | Timeout for one interactive prompt turn in milliseconds (default: 300000) |

### Persistent sessions

By default, each ACP session owns one long-lived `agy --prompt-interactive`
process. The first prompt pays the normal CLI startup cost; later prompts are
submitted through the same PTY and reuse the initialized process and conversation.
Changing the selected model, permission mode, working directory, additional
directories, or `AGY_EXTRA_ARGS` safely restarts that session's process.

Set `AGY_PERSISTENT=0` to restore the original one-shot behavior. This fallback
is useful when a platform does not support Bun's PTY implementation or when
debugging an `agy` TUI compatibility issue.

## Build (Single Executable Application)

```bash
bun run build:mac-arm64    # → dist/agy-acp-darwin-arm64
bun run build:mac-x64      # → dist/agy-acp-darwin-x64
bun run build:linux-arm64  # → dist/agy-acp-linux-arm64
bun run build:linux-x64    # → dist/agy-acp-linux-x64
bun run build:win-arm64    # → dist/agy-acp-windows-arm64.exe
bun run build:win-x64      # → dist/agy-acp-windows-x64.exe
bun run build:all          # all six at once
```

The compiled binary embeds the entire TypeScript source and all dependencies. It
auto-downloads `agy` on first launch if not present next to the executable.

## ACP surface

- **initialize** — advertises `loadSession`, `additionalDirectories`,
  `list`/`delete`/`resume`/`close`, `embeddedContext`.
- **session/new** — accepts `cwd` and `additionalDirectories`; returns the session configuration options (including modes and available models).
- **session/set_config_option** — model and mode selection; persisted per session.
- **session/load** — replays full conversation history from the `agy` SQLite DB,
  including tool calls, task/permission/error decorators, and title updates.
- **session/resume** — re-attaches a client and re-sends `available_commands_update` and `config_option_update` notifications.
- **Post-session notifications** — after every `session/new`, `session/load`, and
  `session/resume` the server sends `available_commands_update` → `config_option_update` in order, so the UI can render the mode picker and model selector immediately.

## Architecture

```
index.ts                      entry: startup, agy auto-install, ACP wiring
src/
  acp/                        ACP surface
    server.ts                 Bun stdio <-> ndJsonStream <-> agent
    agent.ts                  initialize / session.* / prompt / cancel
    sessions.ts               in-memory registry + eviction
    adapter.ts                prompt turns: reuse agy PTY, poll DB, stream
    client.ts                 AgentContext wrapper (notify / request)
  agy/
    binary.ts                 resolve binary: SEA-local / bin/ / $AGY_BIN / PATH
    installer.ts              shared download + SHA-256 verify + extract logic
    process.ts                Bun.spawn, arg building, model discovery
    interactive.ts            long-lived Bun.Terminal / PTY session runtime
  constants/
    index.ts                  shared constants (paths, poll intervals, modes, commands)
  conversation/
    database.ts               bun:sqlite reader (reusable handle)
    scan.ts                   discover new conversation DBs
    translator.ts             shared step -> ACP engine (stream + replay)
    streaming.ts              live poll loop (stream mode)
    replay.ts                 history replay + incremental cache
    columns.ts                error / permission / task decoders
    updates.ts                per-step dispatcher
  updates/                    per-tool ACP builders + shared utils
  store/sessionStore.ts       persistent session bindings (atomic, serialized writes)
  narration/                  narration filter
  gen/steps.ts                generated protobuf
  types/                      type definitions (session, step row)
  utils/lru.ts                small LRU
scripts/
  postinstall.ts              npm install hook: download agy into bin/
```

### Shared streaming/replay engine

Live streaming and history replay differ only in how they treat the agent's
growing text stream. Everything else — tool calls, titles, user prompts, and the
task/permission/error enrichment — is identical, so both drive a single
[`Translator`](src/conversation/translator.ts):

- **stream** emits the newly-appended text slice each poll and dedups tool steps
  it has already sent;
- **replay** buffers consecutive agent-text parts and flushes them as one message
  at each boundary.

### Caching & performance

- **Incremental replay cache** ([replay.ts](src/conversation/replay.ts)): replays
  are cached per conversation and validated by file `(mtime, size)`. An unchanged
  conversation returns instantly; a conversation that merely grew has only its new
  tail of steps read and translated, then appended. (agy DBs are append-only.)
- **Reused DB handle**: the live poll loop keeps one `bun:sqlite` handle +
  prepared statement open for the whole turn instead of reopening each tick.
- **Reused `agy` process**: one PTY-backed interactive process is retained per
  ACP session, eliminating repeated CLI initialization on subsequent prompts.
- **Bun-native throughout**: `bun:sqlite`, `Bun.spawn`, `Bun.stdin`/`Bun.stdout`,
  `Bun.file`/`Bun.write` — no `better-sqlite3`, `protobufjs` runtime, or
  node-stream shims.

## Test

```bash
bun run typecheck
bun test
```
