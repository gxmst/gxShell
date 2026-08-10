# Changelog

All notable gxShell changes are documented here. Release notes are generated
from the version section in this file.

## [1.5.2] - 2026-08-10

### English

- Updated `dompurify` to 3.4.13, `mermaid` to 11.16.1, and two build-time dependencies, clearing five advisories. DOMPurify sanitizes Markdown fetched from remote hosts, so it is on the path that handles untrusted input; the Markdown and Mermaid rendering paths now have direct test coverage.
- Reorganized the repository: the desktop implementation moved from the repository root into `internal/app`, and the guides moved under `docs/`. The root now holds twelve files instead of sixty-six.
- Rewrote the README around a download-first landing page with a Chinese translation, and split the feature, security, development, and release reference into `docs/`.
- Releases are now built and published by a tagged GitHub Actions workflow with a fixed two-asset layout, replacing hand-assembled uploads whose contents differed in every version. `SHA256SUMS.txt` is now LF-terminated so `sha256sum -c` accepts it.
- No change to application behavior. This release exists to publish the reorganized repository and the dependency updates through the new workflow.

### 中文

- 升级 `dompurify` 到 3.4.13、`mermaid` 到 11.16.1 以及两个构建期依赖，清掉 5 条安全公告。DOMPurify 负责净化从远程主机取回的 Markdown，处于处理不可信输入的路径上；Markdown 与 Mermaid 渲染路径现在有了直接的测试覆盖。
- 重新整理仓库结构：桌面实现从仓库根目录移入 `internal/app`，各类说明文档收进 `docs/`。根目录从 66 个文件降到 12 个。
- 重写 README，改为以下载为先的首页并提供中文版；功能、安全、开发和发布说明拆分到 `docs/`。
- 发布改由推 tag 触发的 GitHub Actions 工作流构建和上传，资产固定为两个文件，取代此前每个版本内容都不一样的手工上传。`SHA256SUMS.txt` 改为 LF 换行，`sha256sum -c` 现在可以直接校验。
- 应用行为没有变化。这一版的目的是通过新流程发布整理后的仓库和依赖升级。

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

[1.5.2]: https://github.com/gxmst/gxShell/releases/tag/v1.5.2
[1.5.1]: https://github.com/gxmst/gxShell/releases/tag/v1.5.1
