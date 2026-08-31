# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-08-19

### Added
- **Improved Non-Interactive Agent Usage**: Refactored the ACP (Agent Client Protocol) harness to better support running the agent smoothly in non-interactive environments, improving reliability for background and automated tasks. (#7)
- **Support for `/usage` Command**: The ACP server can now seamlessly handle the `/usage` slash command in non-interactive sessions by leveraging the `agy -p` (print) flag under the hood. (#10)
- **Automated Homebrew Releases**: Integrated a new step into the CI workflow to automatically publish releases to Homebrew, making installation much simpler for macOS users. (#12)

### Fixed
- **Model ID Parsing**: Fixed an issue where the model ID was not being identified correctly. It is now accurately extracted from the first column of the `agy models` CLI output. (#9)

## [1.0.0] - 2026-06-29

### Added
- **Initial Release of Antigravity ACP Server**: Google Antigravity's `agy` CLI does not natively support the Agent Client Protocol (ACP). This server solves that problem by bridging the two—allowing any ACP-compatible editor to seamlessly drive `agy`, stream its progress live, and replay conversation history.
- **Zero-Setup Installation**: Automatically downloads and provisions the correct `agy` CLI binary for your operating system on first launch—no manual setup required.
- **In-Editor Configuration**: Switch AI models or adjust permission modes dynamically directly from your editor's UI without restarting the server.
- **Persistent Session Management**: Conversations are saved automatically. You can list, resume, delete, and manage past sessions directly from your editor without losing history.
- **Multi-Workspace Support**: Work across multiple project directories simultaneously within a single session.
- **Transparent Execution UI**: Provides clear, readable titles and rich descriptions for all agent actions (such as reading files, searching, or running terminal commands) so you always understand what the agent is doing.
- **Single-File Executables**: Distributed as standalone, compiled binaries for macOS, Linux, and Windows. No need to install Bun, Node.js, or external dependencies to run the server.
