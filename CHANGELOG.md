# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Session config options ported from agy-acp: `effort` (`low`|`medium`|`high`), `sandbox`, and dedicated `skip_permissions`, plus mode value `accept-edits`.
- Native `agy` flags for `--mode` (`accept-edits`|`plan`), `--effort`, and `--sandbox`.
- Live and replay `agent_thought_chunk` streaming from AgentText protobuf field 3.
- Swallowed-error detection via agy `cli-*.log` when a turn exits successfully with no streamed updates (e.g. quota / RESOURCE_EXHAUSTED).
- Initialize capability ads for streaming and text prompts.

### Changed
- Plan mode now uses `agy --mode plan` instead of prompt injection.
- `bypassPermissions` remains as a legacy mode alias that enables skip-permissions.

## [1.0.0] - 2026-06-29

### Added
- **Initial Release of Antigravity ACP Server**: Google Antigravity's `agy` CLI does not natively support the Agent Client Protocol (ACP). This server solves that problem by bridging the two—allowing any ACP-compatible editor to seamlessly drive `agy`, stream its progress live, and replay conversation history.
- **Zero-Setup Installation**: Automatically downloads and provisions the correct `agy` CLI binary for your operating system on first launch—no manual setup required.
- **In-Editor Configuration**: Switch AI models or adjust permission modes dynamically directly from your editor's UI without restarting the server.
- **Persistent Session Management**: Conversations are saved automatically. You can list, resume, delete, and manage past sessions directly from your editor without losing history.
- **Multi-Workspace Support**: Work across multiple project directories simultaneously within a single session.
- **Transparent Execution UI**: Provides clear, readable titles and rich descriptions for all agent actions (such as reading files, searching, or running terminal commands) so you always understand what the agent is doing.
- **Single-File Executables**: Distributed as standalone, compiled binaries for macOS, Linux, and Windows. No need to install Bun, Node.js, or external dependencies to run the server.
