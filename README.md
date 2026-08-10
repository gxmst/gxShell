# gxShell

[![Latest release](https://img.shields.io/github/v/release/gxmst/gxShell?display_name=tag)](https://github.com/gxmst/gxShell/releases/latest)
[![CI](https://github.com/gxmst/gxShell/actions/workflows/verify.yml/badge.svg?branch=main)](https://github.com/gxmst/gxShell/actions/workflows/verify.yml)
[![License](https://img.shields.io/badge/license-CC%20BY--NC--SA%204.0-blue.svg)](LICENSE)
![Windows](https://img.shields.io/badge/platform-Windows%20x64-0078d4.svg)

gxShell is a Windows SSH workbench that combines terminal sessions, SFTP,
monitoring, tunnels, AI tools, a local text/Markdown viewer, and an optional
CLI in one desktop app.

[中文说明](README.zh-CN.md)

![gxShell desktop SSH workbench](docs/assets/gxshell-overview.webp)

## Download

Download the latest [Windows x64 release](https://github.com/gxmst/gxShell/releases/latest).
The recommended zip contains the desktop app, `gxshell-cli.exe`, the license,
and a build manifest.

Requirements: Windows 10/11 x64 and the Microsoft WebView2 Runtime. The
unsigned build may show a SmartScreen warning on first launch; use **More
info → Run anyway** only when the checksum matches the release page.

To verify the package on PowerShell:

```powershell
Get-FileHash .\gxShell-v1.5.1-windows-amd64.zip -Algorithm SHA256
```

## Highlights

- Multi-session SSH terminal with reconnect, search, split view, floating tabs, and keyboard navigation.
- SFTP browsing, uploads, downloads, resumable transfers, and local/remote text workflows.
- Linux monitoring, Docker operations, SSH tunnels, services, firewall, cron, and website helpers over SSH.
- AI assistant and an optional local CLI with explicit approvals, trust windows, and named-secret injection.
- Markdown and text viewer/editor with code highlighting, Mermaid diagrams, search, edit, and save.
- Adaptive tabs that shrink, scroll, and expose an all-tabs menu when a workspace gets crowded.
- Windows tray integration, file associations, drag-and-drop opening, and update notifications.
- Security-focused defaults that keep saved credentials out of profile JSON and remote PTY input.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+K` | Search servers, sessions, commands, and workspace actions |
| `Ctrl+F` | Find in the focused terminal or text document |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Alt+1` … `Alt+9` | Jump to a tab |
| `Ctrl+Shift+W` | Close the active tab |
| `Ctrl+S` | Save an edited text file |

## Security

- Passwords, key passphrases, and AI API keys use the OS credential store or an encrypted fallback.
- CLI access is local-only, token-protected, opt-in per profile, and guarded by native confirmations.
- AI and CLI commands apply dangerous-command and sensitive-path policies before execution.
- The app does not send telemetry; its only automatic request is the optional public release check.

Read the full [security model](docs/security.md).

## Documentation

| Topic | Document |
| --- | --- |
| Feature reference | [docs/features.md](docs/features.md) |
| CLI and local API | [docs/cli.md](docs/cli.md) |
| Agent execution contract | [docs/agent-guide.md](docs/agent-guide.md) |
| Architecture notes | [docs/architecture.md](docs/architecture.md) |
| Development | [docs/development.md](docs/development.md) |
| Release process | [docs/releasing.md](docs/releasing.md) |
| Change history | [CHANGELOG.md](CHANGELOG.md) |

## Known limitations

- Windows x64 is the supported release platform. Linux and macOS desktop builds are experimental CI artifacts.
- WebView2, tray behavior, keyring integration, and file associations may differ outside supported Windows versions.
- Monitoring expects Linux-style remote hosts, and Docker management runs over SSH rather than a local Docker socket.
- ProxyJump supports one jump-host level; terminal split view is designed for two visible terminals.

## License

gxShell is licensed under the [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-nc-sa/4.0/) license.
