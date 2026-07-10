# gxShell v1.3.0

## Highlights

- Redesigned the desktop interface with consistent navigation, panels, dialogs, shadows, colors, and transitions.
- Rebuilt the Files workspace with integrated path navigation, search, sorting, selection, keyboard access, transfer actions, and local/remote text workflows.
- Mirrored AI tool and `gxshell-cli` activity into the connected terminal, including commands, output, status, and duration, without injecting data into the remote PTY.
- Added AI/CLI activity indicators to server rows and terminal tabs.
- Reduced the initial frontend bundle through lazy-loaded panels and more focused Markdown/code-highlighting dependencies.
- Fixed early-shutdown panics, SFTP availability handling, concurrent automation indicators, and confirmation bypasses through path-qualified command names.

## 中文说明

- 统一重做桌面端导航、面板、弹窗、阴影、配色与过渡效果。
- 文件模块重写为一体化工作台，加入路径导航、搜索、排序、选中态、键盘操作、传输入口和本地/远程文本工作流。
- AI 工具与 `gxshell-cli` 操作会在对应终端中显示命令、输出、状态和耗时，同时不会向远程 PTY 注入内容。
- 服务器列表和终端标签增加 AI/CLI 活动提示。
- 通过懒加载和精简 Markdown/代码高亮依赖降低前端初始加载成本。
- 修复初始化失败退出、SFTP 可用性、并发自动化提示和带路径命令确认绕过等问题。
