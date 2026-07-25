# gxShell

gxShell is a Windows desktop SSH workbench built with Wails v2, Go, and React. It combines terminal sessions, SFTP, monitoring, Docker tools, SSH tunnels, an AI assistant, an external CLI, and a local text/Markdown viewer in one app.

[中文版本](#中文版本)

![gxShell desktop SSH workbench](docs/assets/gxshell-overview.webp)

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
- Resumable uploads and downloads. An interrupted transfer leaves a `.part` file next to its destination whose name encodes the source's size and modification time. A metadata change invalidates that partial and restarts the transfer; metadata-preserving rewrites cannot be detected without content hashing. Partials below 256 KB restart rather than pay the round trips to resume.
- Multi-file selections transfer a few at a time instead of strictly one after another, so the connection is not left idle for a round trip between files. Every file in a batch is attempted even if one fails.
- Server monitoring for Linux hosts, including CPU, memory, disk, network, and top processes. CPU and memory carry an inline sparkline, and the CPU/network detail cards draw a taller curve annotated with the window's peak. History is a rolling in-memory window per session (the last ~120 samples, about 10 minutes at the default interval); it is deliberately not written to disk and starts over when a session changes.
- Docker container management over SSH, including list, logs, follow logs, start, stop, restart, and remove.
- SSH tunnel management for local, remote, and dynamic SOCKS forwarding. A profile's tunnel rules start automatically with its session.
- Per-profile actions after connecting: a start directory, environment variables, and login commands. Before the session becomes available to the UI, gxShell sends them to its POSIX login shell in one write, so `cd` and `export` affect the shell you are about to use. Directory and variable values are shell-quoted; login commands are deliberately raw and must be non-interactive because all lines are sent together. PowerShell, cmd and other non-POSIX login shells are not supported by this feature. Do not put passwords here — the input stays in terminal scrollback and shell history.
- Network diagnostics with ping and traceroute parsing.
- Session recording of terminal output to asciinema `.cast` files, with a built-in player (play, pause, restart, variable speed) and a recordings panel to play, delete, or reveal saved recordings. Recording taps terminal output only, not stdin; shell-echoed commands can appear in recordings, while password prompts with echo disabled are not captured.
- Reusable command templates with `<name>` variable placeholders. Running a template with placeholders prompts for each value with a live preview before the command is sent, to the active terminal or broadcast to all sessions.
- AI assistant for OpenAI-compatible APIs, with streaming responses, model listing, token usage, terminal context, and explicit native confirmation before remote tool execution.
- External `gxshell-cli` command-line client and local HTTP API that let local tools and AI agents run commands, track jobs, copy remote files, and open temporary loopback SSH tunnels on opted-in profiles through the running app, without exposing saved SSH credentials. Script execution uses an explicit shell and SSH stdin. See [GXSHELL_CLI.md](GXSHELL_CLI.md).
- Model-independent agent guidance, structured execution outcomes, enforced stdin/file handling for multiline scripts, and named `secret://` references for using credentials without placing plaintext values in model prompts, process arguments, confirmations, or command audits.
- Local and remote text/Markdown viewer/editor with sanitized Markdown rendering, plain-text viewing for logs and other text formats, file-open support, drag-and-drop opening, recent files, sibling and relative-link navigation, relative image previews for Markdown, table of contents, code highlighting, Mermaid diagrams, in-document search, zoom, edit, save, split preview, and refresh.
- Windows tray menu for showing the app, creating a connection, opening a text file, settings, and quit.
- Windows text-file integration, including installed file-association metadata and an optional per-user "Open with gxShell" right-click menu entry for supported text formats.
- Update check against the public release feed, with a manual check in settings and a per-version "skip" for the startup prompt. The app never downloads or replaces its own binary: the update action opens the release page in the system browser. The check can be turned off entirely, and it is the only unprompted outbound request gxShell makes.

Supported text viewer/editor extensions: `.md`, `.markdown`, `.txt`, `.text`, `.log`, `.conf`, `.cfg`, `.ini`, `.env`, `.json`, `.jsonl`, `.yaml`, `.yml`, `.toml`, `.xml`, `.csv`, `.tsv`, `.sh`, `.bash`, `.zsh`, `.fish`, `.ps1`, `.bat`, `.cmd`, `.sql`, and `.service`.

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+K` | Search servers, sessions and commands |
| `Ctrl+F` | Find in the focused terminal (the Markdown viewer owns it for text tabs) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab, wrapping at the ends |
| `Alt+1` … `Alt+9` | Jump to the tab at that position |
| `Ctrl+Shift+W` | Close the active tab |
| `Ctrl+S` | Save, while editing a text file |

`Alt+digit` rather than `Ctrl+digit` for tab selection: a terminal sends control
bytes for several `Ctrl+digit` combinations (`Ctrl+3` is ESC, `Ctrl+8` is DEL),
and intercepting those would break the shell. Tab navigation stays available
while a form field has focus, since it edits no text; the other shortcuts yield
to inputs and to open dialogs.

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
- Registered named secrets are stored in the OS credential store (or encrypted fallback), injected only at the execution boundary, and removed from captured output by exact-value redaction.
- Local text-file read/write is limited to files the user opened through the native dialog, OS file-open, drag-and-drop, or authorized text-file siblings.
- Post-connect start directories and environment values are POSIX single-quoted before they are typed, so a value cannot end the command and start another one; control characters and newlines are stripped from all three fields. Login commands are deliberately passed through as written and must not prompt for input. None of these fields are a place for credentials: they appear in terminal scrollback, shell history and session recordings.
- The update check is the only network request gxShell makes on its own. It is an unauthenticated read of the public release feed, sends no credentials or telemetry, and can be turned off entirely in settings. gxShell never downloads or replaces its own binary: the update action opens the release page in the system browser.

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
- Node.js 20.19+ (or 22.13+) and npm — required by ESLint 10 and Vitest 4
- Wails CLI v2
- Microsoft WebView2 Runtime

Common commands:

```powershell
go test ./...
go vet ./...
cd frontend
npm install
npm run lint
npm test
npm run build
cd ..
wails build -clean
```

`npm run lint` is configured to report defects rather than style, so a clean
run means zero errors; the remaining warnings are a standing to-do list.
`npm test` runs the Vitest suite (`npm run test:watch` while developing).

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

1. Bump the version in `backend/version/version.go`, then mirror it in
`wails.json` (`info.productVersion`) and `frontend/package.json`. The Go
constant is the source of truth — the app, the CLI and the update check all read
it — and `scripts/check-version.mjs` runs during the frontend build and fails
if the three disagree.

2. Verify tests and frontend build:

```powershell
go test ./...
cd frontend
npm run lint
npm test
npm run build
cd ..
```

3. Build the Windows executable:

```powershell
wails build -clean
```

4. Build the CLI client:

```powershell
go build -o gxshell-cli.exe .\cmd\gxshell-cli
```

5. Create a GitHub release with the built executables as assets:

```powershell
gh release create v1.5.0 .\build\bin\gxShell.exe .\gxshell-cli.exe --title "gxShell v1.5.0" --notes-file .\release-notes.md
```

Use release notes that describe behavior and fixes only. Do not include local paths, tokens, API keys, server addresses, private hostnames, or log output.

## Known Limitations

- Windows is the only supported release platform. CI also compiles experimental
  unsigned Linux and macOS desktop targets on native runners, but those builds
  have not received runtime testing. Tray integration, keyring behavior, local
  terminals, dialogs, single-instance handling, and packaging may still differ
  or fail outside Windows.
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
- 连接后自动动作：可为每个配置设置起始目录、环境变量和登录命令。在会话交给前端前，gxShell 会把它们一次性写入远端 POSIX 登录 shell；起始目录和环境变量值会做引用处理，登录命令按原样执行且不得要求交互输入。PowerShell、cmd 等非 POSIX 登录 shell 不支持此功能。配置里已有的隧道规则本来就会随连接自动启动。
- 同步输入：将当前终端的键入同步广播到其他已连接的 SSH 终端，并显示明显的广播状态提示。
- 终端输出中的 URL 和远程文件路径可点击。链接检测发生在显示层，不会改写 SSH 输出流；点击 URL 会打开系统浏览器，点击路径会在 SFTP 面板中定位。
- 支持密码和私钥认证，包括私钥 passphrase，以及一层 ProxyJump 跳板机。
- 支持本地终端会话，与远程 SSH 会话并列使用。
- SFTP 文件管理，支持上传、下载、目录下载、重命名、删除、传输进度、更安全的远程路径处理，以及带并发保护的共享 SFTP 客户端缓存。
- 上传和下载支持断点续传。传输中断时会在目标旁留下 `.part` 文件，其文件名编码源文件大小和修改时间；元数据变化会使残片失效并重新传输，但保留元数据的内容覆写无法在不做内容哈希的前提下识别。小于 256 KB 的残片直接重传。
- 多选传输会同时进行几个而不是严格逐个排队，避免每个文件之间白等一个往返。批量中某个文件失败不影响其余文件继续传输。
- Linux 主机监控，包括 CPU、内存、磁盘、网络和进程排行。CPU 和内存行内嵌走势曲线，CPU/网络详情卡片会绘制更高的曲线并标注该窗口的峰值。历史数据是每个会话独立的内存滚动窗口（保留最近约 120 个采样点，默认采集间隔下约 10 分钟），刻意不落盘，切换会话时重新开始。
- 通过 SSH 管理 Docker 容器，包括列表、日志、实时日志、启动、停止、重启和删除。
- SSH 隧道管理，支持本地、远程和动态 SOCKS 转发。
- 网络诊断，支持 ping 和 traceroute 解析。
- 会话录制为 asciinema `.cast` 文件，内置播放器支持播放、暂停、重播和倍速；录制面板可播放、删除或打开录制文件夹。录制只捕获终端输出，不读取 stdin；Shell 回显的命令可能出现在录制中，关闭回显的密码输入不会被捕获。
- 可复用命令模板，支持 `<name>` 变量占位符。执行带占位符的模板时，会先弹出填写窗口并显示实时预览，然后发送到当前终端或广播到所有会话。
- AI 助手支持 OpenAI 兼容 API，包含流式响应、模型列表、token 用量、终端上下文，以及执行远程工具前的原生确认。
- 外部 `gxshell-cli` 命令行客户端和本地 HTTP API，可让本地工具或 AI agent 通过正在运行的 gxShell 在已授权配置上执行命令、跟踪作业、跨服务器复制文件和开启临时回环 SSH 隧道，同时不暴露已保存的 SSH 凭据。脚本执行会显式选择 shell 并通过 SSH stdin 传输。参见 [GXSHELL_CLI.md](GXSHELL_CLI.md)。
- 提供与模型无关的 agent 使用规范、结构化执行结果、对多行脚本强制使用 stdin/file 通道，以及命名 `secret://` 引用，使凭据无需以明文进入模型提示、进程参数、确认框或命令审计。
- 本地和远程文本/Markdown 查看与编辑，支持安全 Markdown 渲染、日志等文本格式查看、文件打开、拖拽打开、最近文件、同目录文件导航、相对链接导航、相对图片预览、目录、代码高亮、Mermaid 图、文内搜索、缩放、编辑、保存、分屏预览和刷新。
- Windows 托盘菜单，支持显示应用、新建连接、打开文本文件、设置和退出。
- Windows 文本文件集成，包括安装时的文件关联元数据，以及可选的当前用户右键菜单 “Open with gxShell”，适用于支持的文本格式。
- 更新检查：启动后查询公共发布源，仅在存在更新的稳定版本时提示，并可在设置里手动检查或彻底关闭。应用不会自行下载或替换自身，"更新"操作只是在系统浏览器里打开发布页。

支持的文本查看/编辑扩展名：`.md`、`.markdown`、`.txt`、`.text`、`.log`、`.conf`、`.cfg`、`.ini`、`.env`、`.json`、`.jsonl`、`.yaml`、`.yml`、`.toml`、`.xml`、`.csv`、`.tsv`、`.sh`、`.bash`、`.zsh`、`.fish`、`.ps1`、`.bat`、`.cmd`、`.sql` 和 `.service`。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl+K` | 搜索服务器和命令 |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 切换到下一个/上一个标签（到头循环） |
| `Alt+1` … `Alt+9` | 按位置切换到第 N 个标签 |
| `Ctrl+F` | 在当前终端里查找（焦点在终端时）；Markdown 标签下为文内查找 |
| `Ctrl+Shift+W` | 关闭当前标签 |
| `Ctrl+S` | 保存正在编辑的文本/Markdown 文件 |

标签快捷键用 `Alt+数字` 而不是 `Ctrl+数字`，因为后者会遮挡终端本身要发送的控制字节（`Ctrl+3` 是 ESC，`Ctrl+8` 是 DEL）。撕出成独立窗口的终端不在标签条里，因此也不参与这些快捷键的顺序。

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
- 已登记的命名秘密存储在系统凭据库（或加密 fallback）中，只在执行边界注入，并按真实值从捕获输出中脱敏。
- 本地文本文件读写仅限用户通过原生文件选择器、系统文件打开、拖拽打开，或授权文本文件同目录关系打开过的文件。
- 连接后自动执行的起始目录和环境变量值会按 POSIX shell 规则加单引号，三个字段都会剥除换行和控制字符。登录命令按原样传递且不得要求交互输入；此功能不支持 PowerShell、cmd 等非 POSIX 登录 shell。这些字段都不适合放凭据：内容会留在终端回滚缓冲、shell 历史和会话录制里。
- 更新检查是 gxShell 唯一主动发起的网络请求。它以匿名方式读取公开发布源，不发送任何凭据或遥测数据，并且可以在设置里彻底关闭。gxShell 不会下载或替换自身二进制文件：更新操作只是在系统浏览器里打开发布页。

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
- Node.js 20.19+ 和 npm（ESLint 10 / Vitest 4 / Vite 7 的下限）
- Wails CLI v2
- Microsoft WebView2 Runtime

常用命令：

```powershell
go test ./...
go vet ./...
cd frontend
npm install
npm run lint
npm test
npm run build
cd ..
wails build -clean
```

`npm run lint` 的配置目标是发现缺陷而不是统一风格，所以干净的一次运行意味着零 error；
剩下的 warning 是一份长期待办清单。`npm test` 运行 Vitest 用例（开发时用
`npm run test:watch`）。

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

1. 在 `backend/version/version.go` 里修改版本号，然后同步到 `wails.json`
（`info.productVersion`）和 `frontend/package.json`。Go 常量是唯一来源——应用、CLI
和更新检查都读它——`scripts/check-version.mjs` 会在前端构建时校验三处是否一致，不一致就报错。

2. 验证测试和前端构建：

```powershell
go test ./...
cd frontend
npm run lint
npm test
npm run build
cd ..
```

3. 构建 Windows 可执行文件：

```powershell
wails build -clean
```

4. 构建 CLI 客户端：

```powershell
go build -o gxshell-cli.exe .\cmd\gxshell-cli
```

5. 创建 GitHub release，并把构建出的可执行文件作为资产上传：

```powershell
gh release create v1.5.0 .\build\bin\gxShell.exe .\gxshell-cli.exe --title "gxShell v1.5.0" --notes-file .\release-notes.md
```

Release notes 只应描述行为和修复。不要包含本地路径、token、API key、服务器地址、私有主机名或日志输出。

## 已知限制

- Windows 是目前唯一正式支持的发布平台。CI 会在原生 runner 上编译实验性的 Linux 和
  macOS 桌面目标，但这些未签名构建尚未经过运行验证；托盘、系统密钥环、本地终端、文件
  对话框、单实例行为和打包结果在非 Windows 平台上仍可能存在差异或无法使用。
- 系统监控面向 Linux 风格的远程主机。
- Docker 管理通过 SSH 执行，不使用本地 Docker socket。
- ProxyJump 支持一层跳板机。
- `gxshell-cli` 会自动遵循目标 profile 的 ProxyJump 设置，但目前没有用于选择或覆盖跳板机的命令行参数。
- 终端分屏设计为一次显示两个终端。

## 许可证

本项目基于 [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-nc-sa/4.0/) 许可证发布。
