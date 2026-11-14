# gxShell

[![Latest release](https://img.shields.io/github/v/release/gxmst/gxShell?display_name=tag)](https://github.com/gxmst/gxShell/releases/latest)
[![CI](https://github.com/gxmst/gxShell/actions/workflows/verify.yml/badge.svg?branch=main)](https://github.com/gxmst/gxShell/actions/workflows/verify.yml)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
![Windows](https://img.shields.io/badge/platform-Windows%20x64-0078d4.svg)

gxShell is a compact SSH workbench for Windows, built with Go, Wails, and
WebView2. It brings terminals, SFTP, monitoring, and remote file editing into
one clean desktop interface.

Use the built-in AI assistant with your own compatible model API, or let
CLI- or MCP-capable tools such as Claude Code and Codex work through your existing SSH
connections. Agents address servers by alias, so you do not need to hand them
SSH passwords or private keys. Approval controls and expiring trust govern
remote operations; external CLI / MCP access is disabled by default.

[Download](#download) · [Demo](#demo) · [Agent guide](docs/agent-guide.md) · [中文说明](README.zh-CN.md)

[![gxShell's English interface with four SSH terminals and a server sidebar](docs/marketing/assets/readme/workspace.webp)](docs/marketing/assets/01-workspace.png)

*The images and video below show the real interface with fictional servers,
commands, metrics, and documents. No personal server data is used.*

## Download

Current version: **1.8.3** — [release notes](CHANGELOG.md#183---2026-11-14).

Download the latest [Windows x64 release](https://github.com/gxmst/gxShell/releases/latest).
The recommended zip keeps the desktop app at its root. The optional CLI,
English and Chinese usage guides, and agent-safety guide are grouped under
`CLI/`; the license and build manifest are also included. The CLI / MCP server is
disabled by default and must be explicitly enabled in Settings.

Requirements: Windows 10/11 x64 and the Microsoft WebView2 Runtime. The
unsigned build may show a SmartScreen warning on first launch; use **More
info → Run anyway** only when the checksum matches the release page.

To verify the package, compare its hash against `SHA256SUMS.txt` from the same
release:

```powershell
Get-FileHash .\gxShell-v<version>-windows-amd64.zip -Algorithm SHA256
```

## Connect AI clients

Enable **CLI / MCP server** in Settings, restart gxShell, and enable access with
an alias on each server you want to expose. Keep gxShell running while using it.

Register the MCP service once in your AI client's global or project settings.
New conversations in that scope can use its tools without repeating setup.
For stdio, generate a configuration fragment from the extracted release folder:

```powershell
.\CLI\gxshell-cli.exe mcp config --client claude --transport stdio
.\CLI\gxshell-cli.exe mcp config --client codex --transport stdio
```

Merge the appropriate fragment into the client settings; these commands print
configuration and do not register it automatically. stdio reads the local token
without putting it in the configuration. Streamable HTTP is also available at
`http://127.0.0.1:56789/mcp` with token authentication. See [MCP setup](docs/mcp.md).
The [CLI and agent guide](docs/agent-guide.md) remain available for clients that
execute local commands; both entrances use the same approvals and SSH sessions.

The [portable gxshell skill](skills/README.md) provides the current operating
contract for Claude Code and Codex. From this repository, ask your agent to
install `skills/gxshell`, or run `scripts/install-skill.ps1 -Client claude` /
`-Client codex`. It includes the required references and is included in future
release packages. gxShell and the CLI still need to be installed separately.

## Demo

[![Animated preview of terminals, remote documents, and command approval — download the full video](docs/marketing/assets/readme/demo-preview.gif)](https://github.com/gxmst/gxShell/raw/refs/heads/main/docs/marketing/assets/gxshell-english-demo.mp4)

**[Download full 39-second demo (MP4, 1080p)](https://github.com/gxmst/gxShell/raw/refs/heads/main/docs/marketing/assets/gxshell-english-demo.mp4)**
· [English subtitles](docs/marketing/assets/gxshell-english-demo.srt)

The short loop above previews three scenes. The full silent video follows a
server check, a remote runbook and configuration file, and an external agent
request where only the read-only checks are approved.

## Highlights

### Built-in AI and access for external agents

The in-app assistant works with terminal context and remote tools. The optional
local CLI lets external agents reuse saved connections without copying SSH
credentials into prompts or agent configuration. `secret://` references also
keep named secret values out of prompts and command arguments.

Use **Settings → Credential vault** to enter a credential in a masked field,
replace or delete it, and copy its reference. Recognized credentials in CLI/MCP
results and AI context are captured locally as reusable references before they
reach a model; failed captures are masked. Bind a reference to an environment
variable through the CLI `--secret` option or the MCP tool's `secrets` object.

The built-in assistant supports OpenAI-compatible, Anthropic, Gemini and Ollama
protocols. Inspection agents produce structured reports with AI assessments,
evidence references and human review. Parallel Hosts runs independent agents for
2–12 connected hosts, with up to three active at once. See
[AI inspection](docs/ai-inspection.md) for the workflow, limits and evaluation.

Review requested operations and approve only the items you choose. Scoped trust
can be granted for 1, 4, 8, or 24 hours; sensitive and high-risk operations still
require confirmation. The separate **Full trust for 1 hour** option requires
native confirmation and lets CLI/MCP commands skip execution approvals,
including credential use. Output protection and recognized host-destruction
guards stay active. Trust expires and can be revoked; copies and imports do not
inherit it. These controls are not a sandbox for arbitrary scripts. See the
[security model](docs/security.md).

[![Command review with a service restart deselected and two read-only checks selected](docs/marketing/assets/readme/agent-review.webp)](docs/marketing/assets/03-agent-review.png)

### Files and documents alongside your terminals

Browse a remote folder, read a Markdown runbook, and edit deployment files
without leaving the workspace. Click either screenshot for the full-size view.

| SFTP and terminal | Remote runbooks |
| --- | --- |
| [![Remote SFTP folder alongside an SSH terminal](docs/marketing/assets/readme/files.webp)](docs/marketing/assets/02-files.png) | [![Remote Markdown runbook with file navigation and an outline](docs/marketing/assets/readme/documents.webp)](docs/marketing/assets/02-documents.png) |

<details>
<summary>View the configuration editor</summary>

[![A fictional YAML deployment configuration open in edit mode](docs/marketing/assets/readme/editor.webp)](docs/marketing/assets/02-editor.png)

</details>

<details>
<summary>Full feature list</summary>

- Local CLI and HTTP API that let scripts and AI agents work on your servers through the app, with alias-only targeting, native approvals, expiring trust, and `secret://` references that keep credentials out of prompts and process arguments.
- [MCP server](docs/mcp.md) over stdio and Streamable HTTP for Claude Code, Codex and compatible clients, sharing the CLI's authorization and SSH connections.
- [Application proxy](docs/proxy.md): follow system, connect directly or use a manual HTTP/HTTPS/SOCKS5 proxy for AI and updates, with optional SSH first-hop proxying.
- Built-in AI assistant over any OpenAI-compatible API, with streaming replies, terminal context, and confirmation before any remote tool call.
- Multi-session SSH terminal with independent terminals for the same server, two- or four-pane layouts, named workspaces, reconnect and broadcast input. Tabs have stable widths, a separate pinned area, overflow arrows, server grouping and search, stable terminal numbers, and confirmed bulk closing.
- Per-server terminal appearance, SSH character encoding, TERM, and Backspace/Delete preferences.
- SFTP browsing, pipelined uploads, downloads, pause/cancel and resumable transfers with verified partial contents, and local/remote document workflows.
- Linux monitoring, Docker operations, SSH tunnels, services, firewall, cron, and website helpers over SSH.
- Local/remote document navigation and editing for Markdown, JSON/JSONC/JSONL/NDJSON, source code, and deployment files; Mermaid zoom, read-only PDF viewing, and responsive large-text previews.
- Encrypted configuration backups with import previews, conflict handling, optional credentials/private keys, and rollback on failed imports.
- Session recording to asciinema `.cast` files with a built-in player, plus opt-in text logs and automatic cleanup by age and total size.
- Windows tray integration, file associations, drag-and-drop opening, and update notifications.

</details>

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+K` | Search servers, sessions, commands, and workspace actions |
| `Ctrl+F` | Find in the focused terminal or document |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Alt+1` … `Alt+9` | Jump to a tab |
| `Ctrl+Shift+W` | Close the active tab |
| `Ctrl+S` | Save an edited document |

## Security

- Passwords, key passphrases, and AI API keys use the OS credential store or an encrypted fallback.
- CLI access is disabled by default. When explicitly enabled, it is local-only, token-protected, opt-in per profile, and guarded by native confirmations.
- AI and CLI commands apply dangerous-command and sensitive-path policies before execution.
- Named credential values and recognized credentials in CLI/MCP results and AI context are protected locally before delivery; arbitrary transformations and unknown unlabeled credentials can evade recognition.
- The app does not send telemetry; its optional public release check is disabled by default.

Read the full [security model](docs/security.md).

## Documentation

| Topic | Document |
| --- | --- |
| Feature reference | [docs/features.md](docs/features.md) |
| Encrypted backup and migration | [docs/development/backup-migration.md](docs/development/backup-migration.md) |
| Session log retention | [docs/development/session-log-retention.md](docs/development/session-log-retention.md) |
| CLI and local API | [docs/cli.md](docs/cli.md) |
| MCP client setup | [docs/mcp.md](docs/mcp.md) |
| Application proxy | [docs/proxy.md](docs/proxy.md) |
| Tab management | [docs/development/tab-management.md](docs/development/tab-management.md) |
| Agent execution contract | [docs/agent-guide.md](docs/agent-guide.md) |
| Architecture notes | [docs/architecture.md](docs/architecture.md) |
| Development | [docs/development.md](docs/development.md) |
| Release process | [docs/releasing.md](docs/releasing.md) |
| Change history | [CHANGELOG.md](CHANGELOG.md) |

## Known limitations

- Windows x64 is the supported release platform. Linux and macOS desktop builds are experimental CI artifacts.
- WebView2, tray behavior, keyring integration, and file associations may differ outside supported Windows versions.
- Monitoring expects Linux-style remote hosts, and Docker management runs over SSH rather than a local Docker socket.
- ProxyJump supports one jump-host level; terminal split view supports up to four visible terminals.
- Text editing supports UTF-8 files up to 5 MiB; PDFs are read-only and limited to 50 MiB.

## License

gxShell is licensed under the [GNU Affero General Public License v3.0](LICENSE).

Commercial use is permitted. Derivative works must be released under the same
license, and if you run a modified version as a network service, its users are
entitled to that version's source. gxShell was previously licensed under
CC BY-NC-SA 4.0, which is not a software license and forbade commercial use;
releases up to and including v1.5.2 remain available under those terms.
