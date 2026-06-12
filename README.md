# gxShell

gxShell 是一个基于 Wails v2、Go 和 React 的 Windows 桌面 SSH 工作台。它把终端、SFTP、系统监控、Docker、SSH 隧道、AI 助手和 Markdown 查看编辑放在一个本地应用里。

gxShell is a Windows desktop SSH workbench built with Wails v2, Go, and React. It combines terminal sessions, SFTP, monitoring, Docker tools, SSH tunnels, an AI assistant, and a local Markdown viewer in one app.

## Features

- SSH terminal sessions with xterm.js, WebGL rendering, reconnect, resize, search, split view, and tear-off floating terminals.
- Password and private-key authentication, including passphrase support and ProxyJump through one jump host.
- Local terminal sessions alongside remote SSH sessions.
- SFTP file management with upload, download, folder download, rename, delete, transfer progress, and safer remote path handling.
- Server monitoring for Linux hosts, including CPU, memory, disk, network, and top processes.
- Docker container management over SSH, including list, logs, follow logs, start, stop, restart, and remove.
- SSH tunnel management for local, remote, and dynamic SOCKS forwarding.
- Network diagnostics with ping and traceroute parsing.
- AI assistant for OpenAI-compatible APIs, with streaming responses, model listing, token usage, terminal context, and explicit native confirmation before remote tool execution.
- Local Markdown viewer/editor with sanitized rendering, file-open support, drag-and-drop opening, sibling file navigation, zoom, edit, save, and refresh.
- Windows tray menu for showing the app, creating a connection, opening Markdown, settings, and quit.
- Windows `.md` file association support when installed.

## Security

- Saved SSH passwords, key passphrases, and AI API keys are not written to profile JSON.
- The app prefers the OS credential store through `go-keyring`.
- If the keyring is unavailable, secrets are stored in an AES-256-GCM fallback file.
- On Windows, the fallback encryption key is wrapped with DPAPI before it is written to disk.
- Older plaintext profile secrets are migrated on startup.
- AI tool calls are registered by the backend, expire after a short TTL, are single-use, and require a native confirmation dialog before command execution or remote file reads.
- Dangerous commands and sensitive remote paths are blocked for AI tools.
- Logs redact common secret fields and avoid persisting AI message content previews.
- Local Markdown read/write is limited to files the user opened through the native dialog, OS file-open, drag-and-drop, or authorized Markdown siblings.

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
| Markdown | `marked`, `DOMPurify` |
| Tray | `github.com/getlantern/systray` |

## Project Layout

```text
gxShell/
├── main.go                    # Wails entry point
├── app.go                     # App wiring and lifecycle
├── app_*.go                   # Bound backend methods split by feature
├── backend/
│   ├── ai/                    # AI providers, streaming, model listing
│   ├── config/                # JSON config store
│   ├── docker/                # Docker commands over SSH
│   ├── localfs/               # Local filesystem helpers
│   ├── localterm/             # Local terminal sessions
│   ├── logger/                # Structured logs and history
│   ├── monitor/               # Linux host metrics
│   ├── network/               # Ping and traceroute
│   ├── secrets/               # Credential storage and fallback encryption
│   ├── sftp/                  # SFTP client cache and transfers
│   ├── ssh/                   # SSH sessions and host-key trust
│   ├── tunnel/                # SSH forwarding
│   └── types/                 # Shared backend types
├── frontend/
│   ├── src/
│   │   ├── components/        # UI panels and dialogs
│   │   ├── hooks/             # React state and terminal hooks
│   │   ├── styles/            # CSS
│   │   └── types.ts           # Frontend types
│   └── wailsjs/               # Generated Wails bindings
├── build/                     # Icons and Windows packaging metadata
└── doc/                       # Project notes and technical docs
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

3. Create a GitHub release with the built executable as an asset:

```powershell
gh release create v1.1.0 .\gxShell.exe --title "gxShell v1.1.0" --notes-file .\release-notes.md
```

Use release notes that describe behavior and fixes only. Do not include local paths, tokens, API keys, server addresses, private hostnames, or log output.

## Known Limitations

- The current release target is Windows.
- System monitoring expects Linux-style remote hosts.
- Docker management runs over SSH and does not use a local Docker socket.
- ProxyJump supports one jump host level.
- Terminal split view is designed for two visible terminals at a time.

## License

This project is licensed under the [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-nc-sa/4.0/) license.
