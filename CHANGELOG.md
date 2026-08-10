# Changelog

All notable gxShell changes are documented here. Release notes are generated
from the version section in this file.

## [1.5.1] - 2026-08-09

### English

- Added an adaptive tab bar that keeps crowded workspaces usable with shrinking tabs, horizontal scrolling, an all-tabs menu, keyboard navigation, and automatic focus scrolling.
- Improved terminal highlighting with xterm decorations, keeping visual annotations out of SSH input and output streams.
- Added safer delete, disconnect, and unsaved-change confirmations, while preventing duplicate submissions and retry-created sessions.
- Expanded global search across connections, open tabs, commands, and workspace actions, with clearer terminal search counts and navigation.
- Made workspace restoration explicitly opt-in and added top-level error handling plus accessibility and keyboard interaction improvements.

### 中文

- 新增自适应标签栏：标签过多时自动收缩并支持横向滚动、全部标签菜单、键盘导航和自动滚动定位。
- 终端高亮改用 xterm decoration，仅影响显示，不再向 SSH 输入输出流注入 ANSI 内容。
- 补充删除、断开连接和未保存更改确认，并避免异步重复提交和重试时重复创建会话。
- 全局搜索覆盖连接、已打开标签、命令和工作区操作；终端搜索增加清晰的匹配计数与导航。
- 工作区恢复改为显式开关，并增加顶层错误兜底、辅助功能和键盘交互改进。

[1.5.1]: https://github.com/gxmst/gxShell/releases/tag/v1.5.1
