# Changelog

All notable gxShell changes are documented here. Release notes are generated
from the version section in this file.

## [1.5.6] - 2026-08-19

### English

- Replaced the external CLI's blacklist-style execution gate with T0-T3 risk classification. Automation trust now auto-approves only scoped, recoverable T1 work; opaque T2 operations and critical T3 operations always require native confirmation, with every T3 request reviewed separately.
- Added localized, classifier-derived explanations to command confirmations and hardened script workflows against upload-and-execute bypasses. Upload approvals now include a hash and preview, execution of remembered uploaded scripts repeats that provenance, and arbitrary interpreters or generated programs are treated as opaque code rather than trusted transport.
- Expanded the document workspace with local and remote PDF viewing through authorized, range-capable streams, and automatically reveals and scrolls the sidebar to the active local document.
- Added syntax-aware JSON and JSONL editing, validation, and formatting while preserving large integers, exponent spellings, and negative zero. Large documents defer full validation until save to keep typing responsive.
- Reduced document-opening work by lazily loading the source editor and Markdown renderer, cancelling stale directory and render requests, and correctly rendering visible non-active split panes without enabling their global shortcuts.
- Added regression coverage for CLI risk tiers and approval behavior, PDF authorization and range handling, JSON numeric fidelity and performance, document navigation, and asynchronous rendering races.

### 中文

- 外部 CLI 的执行门禁由黑名单式判断升级为 T0-T3 风险分级。自动化信任现在只会自动批准范围明确、可恢复的 T1 操作；不透明的 T2 和关键 T3 操作始终需要原生确认，每条 T3 请求必须单独审核。
- 命令确认增加由分类器生成的本地化操作说明，并强化脚本流程以防止通过“上传后执行”绕过审核。上传确认会展示哈希和内容预览；随后执行已记录的上传脚本时会再次展示这些来源信息；任意解释器或生成程序按不透明代码处理，而不是当作可信传输方式。
- 文档工作区加入本地与远程 PDF 查看，通过授权且支持 Range 的流式接口读取；打开本地文档时会自动展开侧栏并滚动定位当前文件。
- 新增带语法支持的 JSON/JSONL 编辑、校验与格式化，并保留大整数、指数写法和负零等原始数值文本。大型文档延后到保存时做完整校验，避免输入卡顿。
- 文档打开路径改为按需加载源码编辑器和 Markdown 渲染器，取消过期的目录与渲染请求，并确保分屏中可见但非活动的文档正常渲染且不会注册全局快捷键。
- 为 CLI 风险分级与审批、PDF 授权与分段读取、JSON 数字保真与性能、文档导航及异步渲染竞态补充了回归测试。

## [1.5.4] - 2026-08-13

### English

- Disabled the local CLI server and automatic startup update checks by default. Existing installations without a deliberate profile-level CLI opt-in migrate to the safer CLI default once; explicit CLI users and later opt-ins are preserved.
- Reorganized release packages so the desktop executable remains unambiguous at the archive root, while the optional CLI is grouped under `CLI/` with English and Chinese usage guides plus the agent safety contract.
- Clarified in Settings and the security documentation that CLI access opens an additional token-protected localhost control surface and that update checks are the app's only optional automatic network request.

### 中文

- 本机 CLI 服务和启动时自动检查更新改为默认关闭。没有明确 profile 级 CLI 授权的旧安装会一次性迁移到更安全的默认值；已明确使用 CLI 的用户以及之后的手动开启会被保留。
- 调整发布包结构：桌面主程序继续清晰地放在压缩包根目录，可选 CLI 则统一收进 `CLI/` 子目录，并附中英文使用说明和 Agent 安全规范。
- 在设置和安全文档中明确说明：CLI 会增加一个受令牌保护的本机控制接口，而更新检查是应用唯一可选的自动网络请求。

## [1.5.3] - 2026-08-13

### English

- Made document zoom dragging responsive on large previews and in the source editor by using compositor-only live previews and committing layout once on release.
- Reduced repeated work in document tabs: cached heading measurements with frame-scheduled scroll tracking, debounced full-document word counts, reused loaded Markdown images and Mermaid diagrams, and isolated hidden viewers from rendering.
- Improved all drag-heavy surfaces, including the document outline, terminal split divider, floating terminals, and floating cards. Pointer capture and frame-scheduled DOM updates now avoid a React render for every pointer sample.
- Streamed authorized local PDFs through the Wails asset server with range-request support instead of transferring Base64 copies through the frontend, substantially reducing peak memory use.
- Bounded log previews to the latest 1 MiB while preserving long single-line tails, and allowed transient Markdown image failures to retry when a tab becomes active again.
- Added focused performance and regression coverage for zooming, image retries and reuse, editor statistics, terminal splitting, PDF authorization and ranges, and bounded log reads.
- Relicensed gxShell under AGPL-3.0 starting with this release. Commercial use is permitted, while modified versions remain available under the same terms; releases through v1.5.2 keep their original license.

### 中文

- 大文档预览和源码编辑器的缩放拖动改为合成层实时预览，松手时才提交一次真实布局，拖动响应更跟手。
- 减少文档标签页的重复工作：缓存标题位置并按帧跟踪滚动、延迟全文字数统计、复用已加载的 Markdown 图片和 Mermaid 图表，并隔离隐藏预览的渲染。
- 优化文档目录、终端分屏、浮动终端和浮动卡片等拖动密集界面；通过指针捕获和按帧直接更新 DOM，避免每个指针采样都触发 React 渲染。
- 本地 PDF 改由 Wails 资源服务在授权后流式传输并支持 Range 请求，不再通过前端传递 Base64 副本，显著降低峰值内存占用。
- 日志预览限制为最新 1 MiB，同时保留超长单行日志的尾部；Markdown 图片的临时加载失败会在标签页再次激活时重试。
- 为缩放、图片重试与复用、编辑器统计、终端分屏、PDF 授权与分段读取、日志读取上限补充了针对性性能与回归测试。
- 从本版本起，gxShell 改用 AGPL-3.0 许可证。商业使用被允许，修改后的版本需继续按相同条款开放；v1.5.2 及更早发布仍沿用原许可证。

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

[1.5.6]: https://github.com/gxmst/gxShell/releases/tag/v1.5.6
[1.5.4]: https://github.com/gxmst/gxShell/releases/tag/v1.5.4
[1.5.3]: https://github.com/gxmst/gxShell/releases/tag/v1.5.3
[1.5.2]: https://github.com/gxmst/gxShell/releases/tag/v1.5.2
[1.5.1]: https://github.com/gxmst/gxShell/releases/tag/v1.5.1
