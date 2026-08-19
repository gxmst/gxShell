# Feature reference

gxShell is organized around a few connected workspaces rather than a single
terminal window.

## Sessions and terminal

- SSH password and private-key authentication, passphrases, ProxyJump, reconnect, resize, search, split view, floating terminals, and adaptive tabs.
- Local terminals beside remote sessions, synchronized broadcast input, clickable URLs and remote paths, and terminal recordings with an asciinema player.
- Per-profile start directories, environment variables, login commands, tunnel rules, and optional workspace restoration.

## Files and documents

- SFTP browsing with path navigation, search, sorting, selection, rename, delete, transfer progress, folder downloads, resumable transfers, and conflict protection.
- Local and remote text/Markdown viewing and editing with sanitized rendering, code highlighting, Mermaid diagrams, table of contents, relative links/images, search, zoom, save, and refresh.
- Local and remote PDF viewing through authorized, range-capable document streams, plus syntax-aware JSON/JSONL editing with validation and token-preserving formatting.
- Opening a local document reveals its workspace and scrolls the current-folder list to the active file.

Supported text extensions include `.md`, `.markdown`, `.txt`, `.log`, `.conf`,
`.cfg`, `.ini`, `.env`, `.json`, `.jsonl`, `.yaml`, `.yml`, `.toml`, `.xml`,
`.csv`, `.tsv`, `.sh`, `.bash`, `.zsh`, `.fish`, `.ps1`, `.bat`, `.cmd`, `.sql`,
and `.service`. PDF documents use the view-only `.pdf` workflow.

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
