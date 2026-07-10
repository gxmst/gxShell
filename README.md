# gxShell

gxShell is a Windows desktop SSH workbench built with Wails v2, Go, and React. It combines terminal sessions, SFTP, monitoring, Docker tools, SSH tunnels, an AI assistant, an external CLI, and a local text/Markdown viewer in one app.

[中文版本](#中文版本)

## What's New in v1.3.0

- Refreshed the complete desktop interface with a more consistent visual system, smoother transitions, modern surfaces, and unified dialogs across connections, tools, files, AI, settings, and terminal overlays.
- Rebuilt the Files workspace around one continuous file browser with path navigation, search, sorting, selection, keyboard access, compact actions, transfer shortcuts, recent text files, and local/remote text workflows.
- AI tools and external `gxshell-cli` commands now mirror their command, output, completion state, and duration into the connected terminal without writing into the remote PTY. AI/CLI activity is also visible on server and terminal tabs.
- Reduced frontend startup cost through lazy-loaded tool panels, scoped Markdown styles, and a smaller highlight.js language set.
- Improved reliability around early shutdown, SFTP availability checks, concurrent AI/CLI activity indicators, and confirmation handling for path-qualified commands.

## Features

- SSH terminal sessions with xterm.js, WebGL rendering, reconnect, resize, search, split view, tear-off floating terminals, and drag-to-reorder tabs.
- Automatic reconnect for profiles that opt in: dropped sessions retry with backoff (only when the profile can reconnect without prompting for a secret).
- Synchronized input (broadcast typing) that mirrors keystrokes from the active terminal to every other connected SSH terminal, with a prominent active-broadcast banner.
- Clickable URLs and remote file paths in terminal output, rendered in the display layer so the SSH output stream is never rewritten. Clicking a URL opens the system browser; clicking a path reveals it in the SFTP drawer.
- Password and private-key authentication, including passphrase support and ProxyJump through one jump host.
- Local terminal sessions alongside remote SSH sessions.
- SFTP file management with upload, download, folder download, rename, delete, transfer progress, safer remote path handling, and a guarded shared SFTP client cache for concurrent operations.
- Server monitoring for Linux hosts, including CPU, memory, disk, network, and top processes.
- Docker container management over SSH, including list, logs, follow logs, start, stop, restart, and remove.
- SSH tunnel management for local, remote, and dynamic SOCKS forwarding.
- Network diagnostics with ping and traceroute parsing.
- Session recording of terminal output to asciinema `.cast` files, with a built-in player (play, pause, restart, variable speed) and a recordings panel to play, delete, or reveal saved recordings. Recording taps terminal output only, not stdin; shell-echoed commands can appear in recordings, while password prompts with echo disabled are not captured.
- Reusable command templates with `<name>` variable placeholders. Running a template with placeholders prompts for each value with a live preview before the command is sent, to the active terminal or broadcast to all sessions.
- AI assistant for OpenAI-compatible APIs, with streaming responses, model listing, token usage, terminal context, and explicit native confirmation before remote tool execution.
- External `gxshell-cli` command-line client and local HTTP API that let local tools and AI agents run commands on opted-in profiles through the running app, without exposing saved SSH credentials. The CLI can be disabled globally, reuses active SSH sessions when possible, follows each profile's ProxyJump setting, runs simple read-only commands directly, batches approval prompts for nearby external requests, supports `--json`, `--timeout`, `exec-file`, `exec-stdin`, and `doctor`, and requires native confirmation for anything else. See [GXSHELL_CLI.md](GXSHELL_CLI.md).
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
- The external `gxshell-cli` interface can be disabled globally, requires a local bearer token when enabled, exposes only opted-in profile aliases (never hosts, users, ports, profile IDs, or jump-host details), blocks dangerous commands and sensitive paths with diagnostic reason/detail fields, and requires native confirmation for anything that is not a simple read-only command. Nearby requests for the same alias are batched into one native prompt.
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

Run `.\gxshell-cli.exe doctor` to check the CLI executable path, token, PATH status, and GUI daemon reachability.

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
gh release create v1.3.0 .\build\bin\gxShell.exe .\gxshell-cli.exe --title "gxShell v1.3.0" --notes-file .\release-notes.md
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

---

# 中文版本

[Back to English](#gxshell)

gxShell 是一个基于 Wails v2、Go 和 React 构建的 Windows 桌面 SSH 工作台。它把终端会话、SFTP、主机监控、Docker 工具、SSH 隧道、AI 助手、外部 CLI，以及本地文本/Markdown 查看器整合在一个应用里。

## v1.3.0 更新内容

- 统一重做桌面端视觉风格，为连接、工具、文件、AI、设置、终端浮层和弹窗补充更一致的布局、过渡效果、配色、阴影与交互反馈。
- 文件模块重写为连续的文件工作台，支持路径导航、搜索、排序、选中态、键盘操作、精简操作菜单、传输入口、最近文本文件，以及本地/远程文本工作流。
- AI 工具和外部 `gxshell-cli` 命令现在会把命令、输出、完成状态和耗时回显到对应终端，但不会写入远程 PTY；服务器列表和终端标签也会显示 AI/CLI 活动提示。
- 通过工具面板懒加载、Markdown 样式按需加载和精简 highlight.js 语言集降低前端启动与打包成本。
- 修复初始化失败时退出、SFTP 可用性判断、并发 AI/CLI 状态提示，以及带路径命令免确认等细节问题。

## 功能特性

- SSH 终端会话，支持 xterm.js、WebGL 渲染、重连、调整尺寸、搜索、分屏、浮动终端，以及标签拖拽排序。
- 可选自动重连：启用后，异常断开的会话会按退避策略重试；仅对无需再次输入密钥/密码的配置生效。
- 同步输入：将当前终端的键入同步广播到其他已连接的 SSH 终端，并显示明显的广播状态提示。
- 终端输出中的 URL 和远程文件路径可点击。链接检测发生在显示层，不会改写 SSH 输出流；点击 URL 会打开系统浏览器，点击路径会在 SFTP 面板中定位。
- 支持密码和私钥认证，包括私钥 passphrase，以及一层 ProxyJump 跳板机。
- 支持本地终端会话，与远程 SSH 会话并列使用。
- SFTP 文件管理，支持上传、下载、目录下载、重命名、删除、传输进度、更安全的远程路径处理，以及带并发保护的共享 SFTP 客户端缓存。
- Linux 主机监控，包括 CPU、内存、磁盘、网络和进程排行。
- 通过 SSH 管理 Docker 容器，包括列表、日志、实时日志、启动、停止、重启和删除。
- SSH 隧道管理，支持本地、远程和动态 SOCKS 转发。
- 网络诊断，支持 ping 和 traceroute 解析。
- 会话录制为 asciinema `.cast` 文件，内置播放器支持播放、暂停、重播和倍速；录制面板可播放、删除或打开录制文件夹。录制只捕获终端输出，不读取 stdin；Shell 回显的命令可能出现在录制中，关闭回显的密码输入不会被捕获。
- 可复用命令模板，支持 `<name>` 变量占位符。执行带占位符的模板时，会先弹出填写窗口并显示实时预览，然后发送到当前终端或广播到所有会话。
- AI 助手支持 OpenAI 兼容 API，包含流式响应、模型列表、token 用量、终端上下文，以及执行远程工具前的原生确认。
- 外部 `gxshell-cli` 命令行客户端和本地 HTTP API，可让本地工具或 AI agent 通过正在运行的 gxShell 在已授权配置上执行命令，同时不暴露已保存的 SSH 凭据。CLI 可全局关闭，可复用活动 SSH 会话，遵循目标配置的 ProxyJump 设置，支持简单只读命令直通、邻近请求合并确认、`--json`、`--timeout`、`exec-file`、`exec-stdin` 和 `doctor`，其余操作需要原生确认。参见 [GXSHELL_CLI.md](GXSHELL_CLI.md)。
- 本地和远程文本/Markdown 查看与编辑，支持安全 Markdown 渲染、日志等文本格式查看、文件打开、拖拽打开、最近文件、同目录文件导航、相对链接导航、相对图片预览、目录、代码高亮、Mermaid 图、文内搜索、缩放、编辑、保存、分屏预览和刷新。
- Windows 托盘菜单，支持显示应用、新建连接、打开文本文件、设置和退出。
- Windows 文本文件集成，包括安装时的文件关联元数据，以及可选的当前用户右键菜单 “Open with gxShell”，适用于支持的文本格式。

支持的文本查看/编辑扩展名：`.md`、`.markdown`、`.txt`、`.text`、`.log`、`.conf`、`.cfg`、`.ini`、`.env`、`.json`、`.jsonl`、`.yaml`、`.yml`、`.toml`、`.xml`、`.csv`、`.tsv`、`.sh`、`.bash`、`.zsh`、`.fish`、`.ps1`、`.bat`、`.cmd`、`.sql` 和 `.service`。

## 安全

- 已保存的 SSH 密码、私钥 passphrase 和 AI API key 不会写入 profile JSON。
- 应用优先使用操作系统凭据存储，即 `go-keyring`。
- 如果 keyring 不可用，密钥会存储在 AES-256-GCM 加密的 fallback 文件中。
- 在 Windows 上，fallback 加密密钥写入磁盘前会通过 DPAPI 包装。
- 旧版本明文 profile 密钥会在启动时迁移。
- AI 工具调用由后端登记，短时间后过期，只能使用一次，并且在执行命令或读取远程文件前需要原生确认。多个待处理 AI 工具可以一起批准，批准后的独立命令可并行执行。
- AI 工具会阻止危险命令和敏感远程路径。
- 外部 `gxshell-cli` 接口可全局关闭；启用时需要本地 bearer token，只暴露已授权的 profile alias，不暴露主机、用户名、端口、profile ID 或跳板机细节；会阻止危险命令和敏感路径，并返回诊断用的原因/详情字段；除简单只读命令外都需要原生确认。针对同一 alias 的邻近请求会合并到一个原生确认窗口中。
- CLI 命令通过 gxShell 管理的 SSH 会话执行。已有会话可能被复用，但每个命令会使用独立的短生命周期 SSH exec channel，而不是输入到交互式终端中。
- 日志会脱敏常见密钥字段，并避免持久化 AI 消息内容预览。
- 本地文本文件读写仅限用户通过原生文件选择器、系统文件打开、拖拽打开，或授权文本文件同目录关系打开过的文件。

## 技术栈

| 领域 | 技术 |
| --- | --- |
| 桌面端 | Wails v2 |
| 后端 | Go 1.24 |
| 前端 | React 18、TypeScript、Vite |
| 终端 | `@xterm/xterm`，配合 Fit、Search 和 WebGL addons |
| SSH | `golang.org/x/crypto/ssh` |
| SFTP | `github.com/pkg/sftp` |
| 密钥 | `go-keyring`、AES-256-GCM、Windows DPAPI fallback 包装 |
| 文本/Markdown | `marked`、`DOMPurify`、`highlight.js`、`mermaid` |
| 托盘 | `github.com/getlantern/systray` |

## 项目结构

```text
gxShell/
|-- main.go                    # Wails 入口
|-- app.go                     # 应用装配和生命周期
|-- app_*.go                   # 按功能拆分的后端绑定方法
|-- cmd/gxshell-cli/           # 外部命令行客户端，单独构建
|-- backend/
|   |-- ai/                    # AI provider、流式响应、模型列表
|   |-- config/                # JSON 配置存储
|   |-- docker/                # 通过 SSH 执行 Docker 命令
|   |-- localfs/               # 本地文件系统辅助
|   |-- localterm/             # 本地终端会话
|   |-- logger/                # 结构化日志和命令历史
|   |-- monitor/               # Linux 主机指标
|   |-- network/               # Ping 和 traceroute
|   |-- secrets/               # 凭据存储和 fallback 加密
|   |-- sftp/                  # SFTP 客户端缓存和传输
|   |-- ssh/                   # SSH 会话和主机密钥信任
|   |-- tunnel/                # SSH 转发
|   `-- types/                 # 后端共享类型
|-- frontend/
|   |-- src/
|   |   |-- components/        # UI 面板和弹窗
|   |   |-- hooks/             # React 状态和终端 hooks
|   |   |-- styles/            # CSS
|   |   `-- types.ts           # 前端类型
|   `-- wailsjs/               # Wails 生成绑定
|-- build/                     # 图标和 Windows 打包元数据
`-- doc/                       # 项目说明和技术文档
```

## 开发

前置要求：

- Go 1.24+
- Node.js 18+ 和 npm
- Wails CLI v2
- Microsoft WebView2 Runtime

常用命令：

```powershell
go test ./...
cd frontend
npm install
npm run build
cd ..
wails build -clean
```

Windows 可执行文件通常生成在：

```text
build/bin/gxShell.exe
```

某些本地 release 实验也可能在仓库根目录生成 `gxShell.exe`。该文件已被 Git 忽略，应该作为 release 资产上传，而不是提交到仓库。

CLI 客户端是独立于 Wails 桌面应用的二进制文件。需要使用或发布 `gxshell-cli` 时，请单独构建：

```powershell
go build -o gxshell-cli.exe .\cmd\gxshell-cli
```

运行 `.\gxshell-cli.exe doctor` 可以检查 CLI 可执行文件位置、token、PATH 状态和 GUI daemon 连通性。

## 发布

1. 验证测试和前端构建：

```powershell
go test ./...
cd frontend
npm run build
cd ..
```

2. 构建 Windows 可执行文件：

```powershell
wails build -clean
```

3. 构建 CLI 客户端：

```powershell
go build -o gxshell-cli.exe .\cmd\gxshell-cli
```

4. 创建 GitHub release，并把构建出的可执行文件作为资产上传：

```powershell
gh release create v1.3.0 .\build\bin\gxShell.exe .\gxshell-cli.exe --title "gxShell v1.3.0" --notes-file .\release-notes.md
```

Release notes 只应描述行为和修复。不要包含本地路径、token、API key、服务器地址、私有主机名或日志输出。

## 已知限制

- 当前 release 目标平台是 Windows。
- 系统监控面向 Linux 风格的远程主机。
- Docker 管理通过 SSH 执行，不使用本地 Docker socket。
- ProxyJump 支持一层跳板机。
- `gxshell-cli` 会自动遵循目标 profile 的 ProxyJump 设置，但目前没有用于选择或覆盖跳板机的命令行参数。
- 终端分屏设计为一次显示两个终端。

## 许可证

本项目基于 [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-nc-sa/4.0/) 许可证发布。
