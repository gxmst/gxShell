# gxShell

gxShell is a Windows desktop SSH workbench built with Wails v2, Go, and React. It combines terminal sessions, SFTP, monitoring, Docker tools, SSH tunnels, an AI assistant, an external CLI, and a local text/Markdown viewer in one app.

## Features

- SSH terminal sessions with xterm.js, WebGL rendering, reconnect, resize, search, split view, and tear-off floating terminals.
- Password and private-key authentication, including passphrase support and ProxyJump through one jump host.
- Local terminal sessions alongside remote SSH sessions.
- SFTP file management with upload, download, folder download, rename, delete, transfer progress, safer remote path handling, and a guarded shared SFTP client cache for concurrent operations.
- Server monitoring for Linux hosts, including CPU, memory, disk, network, and top processes.
- Docker container management over SSH, including list, logs, follow logs, start, stop, restart, and remove.
- SSH tunnel management for local, remote, and dynamic SOCKS forwarding.
- Network diagnostics with ping and traceroute parsing.
- AI assistant for OpenAI-compatible APIs, with streaming responses, model listing, token usage, terminal context, and explicit native confirmation before remote tool execution.
- External `gxshell-cli` command-line client and local HTTP API that let local tools and AI agents run commands on opted-in profiles through the running app, without exposing saved SSH credentials. The CLI can be disabled globally, reuses active SSH sessions when possible, follows each profile's ProxyJump setting, runs simple read-only commands directly, batches approval prompts for nearby external requests, supports `--json`, `--timeout`, `exec-file`, and `exec-stdin`, and requires native confirmation for anything else. See [GXSHELL_CLI.md](GXSHELL_CLI.md).
- Local and remote text/Markdown viewer/editor with sanitized Markdown rendering, plain-text viewing for logs and other text formats, file-open support, drag-and-drop opening, recent files, sibling and relative-link navigation, relative image previews for Markdown, table of contents, code highlighting, Mermaid diagrams, in-document search, zoom, edit, save, split preview, and refresh.
- Windows tray menu for showing the app, creating a connection, opening a text file, settings, and quit.
- Windows text-file integration, including installed file-association metadata and an optional per-user "Open with gxShell" right-click menu entry for supported text formats.

Supported text viewer/editor extensions: `.md`, `.markdown`, `.txt`, `.text`, `.log`, `.conf`, `.cfg`, `.ini`, `.env`, `.json`, `.jsonl`, `.yaml`, `.yml`, `.toml`, `.xml`, `.csv`, `.tsv`, `.sh`, `.bash`, `.zsh`, `.fish`, `.ps1`, `.bat`, `.cmd`, `.sql`, and `.service`.

## Security

- Saved SSH passwords, key passphrases, and AI API keys are not written to profile JSON.
- The app prefers the OS credential store through `go-keyring`.
- If the keyring is unavailable, secrets are stored in an AES-256-GCM fallback file.
- On Windows, the fallback encryption key is wrapped with DPAPI before it is written to disk.
- Older plaintext profile secrets are migrated on startup.
- AI tool calls are registered by the backend, expire after a short TTL, are single-use, and require a native confirmation dialog before command execution or remote file reads. Multiple pending AI tools can be approved together and independent commands run in parallel after approval.
- Dangerous commands and sensitive remote paths are blocked for AI tools.
- The external `gxshell-cli` interface can be disabled globally, requires a local bearer token when enabled, exposes only opted-in profile aliases (never hosts, users, ports, profile IDs, or jump-host details), blocks dangerous commands and sensitive paths, and requires native confirmation for anything that is not a simple read-only command. Nearby requests for the same alias are batched into one native prompt.
- CLI commands run through gxShell-managed SSH sessions. Existing sessions may be reused, but each command uses a separate short-lived SSH exec channel rather than typing into the interactive terminal.
- Logs redact common secret fields and avoid persisting AI message content previews.
- Local text-file read/write is limited to files the user opened through the native dialog, OS file-open, drag-and-drop, or authorized text-file siblings.

## Tech Stack

| Area | Technology |
| --- | --- |
| Desktop | Wails v2 |
| Backend | Go 1.24 |
| Frontend | React 18, TypeScript, Vite |
| Terminal | `@xterm/xterm` with Fit, Search, and WebGL addons |
| SSH | `golang.org/x/crypto/ssh` |
| SFTP | `github.com/pkg/sftp` |
| Secrets | `go-keyring`, AES-256-GCM, Windows DPAPI fallback wrapping |
| Text/Markdown | `marked`, `DOMPurify`, `highlight.js`, `mermaid` |
| Tray | `github.com/getlantern/systray` |

## Project Layout

```text
gxShell/
|-- main.go                    # Wails entry point
|-- app.go                     # App wiring and lifecycle
|-- app_*.go                   # Bound backend methods split by feature
|-- cmd/gxshell-cli/           # External command-line client (separate binary)
|-- backend/
|   |-- ai/                    # AI providers, streaming, model listing
|   |-- config/                # JSON config store
|   |-- docker/                # Docker commands over SSH
|   |-- localfs/               # Local filesystem helpers
|   |-- localterm/             # Local terminal sessions
|   |-- logger/                # Structured logs and history
|   |-- monitor/               # Linux host metrics
|   |-- network/               # Ping and traceroute
|   |-- secrets/               # Credential storage and fallback encryption
|   |-- sftp/                  # SFTP client cache and transfers
|   |-- ssh/                   # SSH sessions and host-key trust
|   |-- tunnel/                # SSH forwarding
|   `-- types/                 # Shared backend types
|-- frontend/
|   |-- src/
|   |   |-- components/        # UI panels and dialogs
|   |   |-- hooks/             # React state and terminal hooks
|   |   |-- styles/            # CSS
|   |   `-- types.ts           # Frontend types
|   `-- wailsjs/               # Generated Wails bindings
|-- build/                     # Icons and Windows packaging metadata
`-- doc/                       # Project notes and technical docs
```

## Development

Prerequisites:

- Go 1.24+
- Node.js 18+ and npm
- Wails CLI v2
- Microsoft WebView2 Runtime

Common commands:

```powershell
go test ./...
cd frontend
npm install
npm run build
cd ..
wails build -clean
```

The Windows binary is normally produced under:

```text
build/bin/gxShell.exe
```

Some local release experiments may also produce `gxShell.exe` at the repository root. That file is ignored by Git and should be uploaded as a release asset, not committed.

The CLI client is a separate binary from the Wails desktop app. Build it explicitly when you want to use or ship `gxshell-cli`:

```powershell
go build -o gxshell-cli.exe .\cmd\gxshell-cli
```

## Release

1. Verify tests and frontend build:

```powershell
go test ./...
cd frontend
npm run build
cd ..
```

2. Build the Windows executable:

```powershell
wails build -clean
```

3. Build the CLI client:

```powershell
go build -o gxshell-cli.exe .\cmd\gxshell-cli
```

4. Create a GitHub release with the built executables as assets:

```powershell
gh release create v1.1.3 .\build\bin\gxShell.exe .\gxshell-cli.exe --title "gxShell v1.1.3" --notes-file .\release-notes.md
```

Use release notes that describe behavior and fixes only. Do not include local paths, tokens, API keys, server addresses, private hostnames, or log output.

## Known Limitations

- The current release target is Windows.
- System monitoring expects Linux-style remote hosts.
- Docker management runs over SSH and does not use a local Docker socket.
- ProxyJump supports one jump host level.
- `gxshell-cli` follows the target profile's ProxyJump setting automatically, but it does not have a command-line flag for choosing or overriding the jump host.
- Terminal split view is designed for two visible terminals at a time.

## License

This project is licensed under the [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-nc-sa/4.0/) license.
