# Feature reference

gxShell is organized around a few connected workspaces rather than a single
terminal window.

## Sessions and terminal

- SSH password and private-key authentication, passphrases, ProxyJump, reconnect, resize, search, split view, floating terminals, and adaptive tabs.
- Local terminals beside remote sessions, synchronized broadcast input, clickable URLs and remote paths, and terminal recordings with an asciinema player.
- Per-profile start directories, environment variables, login commands, tunnel rules, and optional workspace restoration.
- Independent terminals for one saved server, named workspaces, and two- or four-pane layouts that can be restored together.
- Per-server terminal appearance, SSH character encoding, TERM, and Backspace/Delete preferences.
- Optional text session logs with separate opt-in cleanup by age and total size; active connections remain protected. See [session log retention](development/session-log-retention.md).

## Backup and migration

- Encrypted configuration backups cover server profiles, commands, global settings, highlight rules, named workspaces and trusted host keys.
- Credentials and private keys are optional exports requiring native confirmation. Import previews show conflicts and AI configuration changes before applying them, with rollback on operation failures.
- External files and live sessions are not included. Local CLI/update opt-ins, document grants and log-cleanup preferences stay on the destination computer. See [backup and migration](development/backup-migration.md).

## Files and documents

- SFTP browsing with path navigation, search, sorting, selection, rename, delete, transfer progress, folder downloads, resumable transfers, and conflict protection.
- Local and remote text/Markdown viewing and editing with sanitized rendering, code highlighting, Mermaid diagrams, table of contents, relative links/images, search, zoom, save, and refresh.
- Local and remote PDF viewing through authorized, range-capable document streams, plus JSON/JSONC/JSONL editing with validation and token-preserving formatting. JSONC formatting retains comments and trailing commas; NDJSON uses the JSON Lines workflow.
- Documents have a separate navigation entry with the current folder, file filter, refresh, reveal-current action and recent documents. Large folders show 200 files per page; filtering searches the entire listing and reveal-current selects the right page. Switching to an existing or restored document selects this panel; returning to a terminal restores its previous tool. Settings and AI remain available across tab switches.
- Terminal and document panels share the same width. A narrower window temporarily clamps it without losing the saved preference. Sidebar toggles change terminal geometry once, with a short panel fade instead of animating every intermediate width.
- Tabs keep readable widths and scroll horizontally. The active tab stays visible after window resizing, and the searchable all-tabs picker shows full names and host/path details, supports arrow-key navigation and respects Chinese input composition.
- JSON/JSONC/JSONL operations above 256 K UTF-16 code units run in a worker. Saving still validates the snapshot being written; formatting never replaces edits made while processing, and closing a document cancels pending parsing.
- Large text previews render only visible lines in a read-only source view, with full-document search and copying. SSH reconnects during JSON validation use the replacement connection for saving.
- Editable documents must contain UTF-8 text. Binary data and unsupported encodings are rejected before preview and before overwriting an existing local or remote file. Local document links and special files are excluded; directory authorization is rechecked at IO time.

Supported text extensions include `.md`, `.markdown`, `.txt`, `.log`, `.conf`,
`.cfg`, `.ini`, `.env`, `.json`, `.jsonc`, `.jsonl`, `.ndjson`, `.yaml`, `.yml`, `.toml`, `.xml`,
`.csv`, `.tsv`, `.sh`, `.bash`, `.zsh`, `.fish`, `.ps1`, `.bat`, `.cmd`, `.sql`,
and `.service`. Common source text (`.py`, `.js`, `.mjs`, `.cjs`, `.ts`, `.jsx`,
`.tsx`, `.go`, `.html`, `.htm`, `.css`) is also supported. HTML is shown as source
text. Named deployment files include `Dockerfile`, `Containerfile`, `Makefile`,
`GNUmakefile`, `Justfile`, `.gitignore`, `.gitattributes`, `.dockerignore`,
`.editorconfig`, `.bashrc`, `.zshrc`, `.profile`, and `.env.*` / `Dockerfile.*` /
`Containerfile.*` variants. PDF documents use the view-only `.pdf` workflow.
Office documents and standalone images are not document-tab formats.

## Remote operations

- Linux CPU, memory, disk, network, and process monitoring with short rolling history.
- Docker containers and logs, system services, firewall helpers, Cron jobs, websites, ping, and traceroute over SSH.
- Local, remote, and dynamic SOCKS tunnel management.

## AI and CLI

- OpenAI-compatible AI providers with streaming, model listing, usage, terminal context, and native confirmation before remote tools run.
- `gxshell-cli` and its local HTTP API for approved commands, jobs, file transfers, remote copies, and temporary loopback tunnels.
- Named `secret://` references keep credentials out of prompts, argv, confirmations, and command audits.

## Windows integration

- Tray menu, file associations, optional context-menu registration, drag-and-drop opening, and public-release update checks.
