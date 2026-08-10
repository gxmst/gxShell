# gxShell

[![最新版本](https://img.shields.io/github/v/release/gxmst/gxShell?display_name=tag)](https://github.com/gxmst/gxShell/releases/latest)
[![CI](https://github.com/gxmst/gxShell/actions/workflows/verify.yml/badge.svg?branch=main)](https://github.com/gxmst/gxShell/actions/workflows/verify.yml)
[![许可证](https://img.shields.io/badge/license-CC%20BY--NC--SA%204.0-blue.svg)](LICENSE)
![Windows](https://img.shields.io/badge/platform-Windows%20x64-0078d4.svg)

gxShell 是一个 Windows SSH 工作台，把终端会话、SFTP、监控、隧道、AI
工具、本地文本/Markdown 查看器和可选 CLI 集成在一个桌面应用中。

[English](README.md)

![gxShell 桌面 SSH 工作台](docs/assets/gxshell-overview.webp)

## 下载

前往 [Windows x64 最新版](https://github.com/gxmst/gxShell/releases/latest)。
推荐下载 zip，里面包含桌面应用、`gxshell-cli.exe`、许可证和构建清单。

运行要求：Windows 10/11 x64，以及 Microsoft WebView2 Runtime。未签名版本
首次启动可能显示 SmartScreen 提示；只有在校验和与 Release 页面一致时，才应点
“更多信息 → 仍要运行”。

校验时，用下面的命令与同一个 Release 里的 `SHA256SUMS.txt` 比对：

```powershell
Get-FileHash .\gxShell-v<版本>-windows-amd64.zip -Algorithm SHA256
```

## 主要功能

- 多会话 SSH 终端，支持重连、搜索、分屏、浮动标签和键盘导航。
- SFTP 浏览、上传、下载、断点续传，以及本地/远程文本工作流。
- 通过 SSH 提供 Linux 监控、Docker、隧道、服务、防火墙、Cron 和网站工具。
- AI 助手和可选本地 CLI，支持显式确认、限时信任和命名密钥注入。
- Markdown 和文本查看/编辑，支持代码高亮、Mermaid、搜索、编辑和保存。
- 标签页过多时自动收缩、滚动，并提供全部标签菜单。
- Windows 托盘、文件关联、拖放打开和更新提示。
- 默认优先保护凭据，不把保存的密钥写入 profile JSON 或远程 PTY。

## 快捷键

| 快捷键 | 操作 |
| --- | --- |
| `Ctrl+K` | 搜索服务器、会话、命令和工作区操作 |
| `Ctrl+F` | 在终端或文本文件中搜索 |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 切换前后标签 |
| `Alt+1` … `Alt+9` | 跳转到对应标签 |
| `Ctrl+Shift+W` | 关闭当前标签 |
| `Ctrl+S` | 保存文本文件 |

## 安全

- 密码、密钥口令和 AI API Key 使用系统凭据存储或加密回退存储。
- CLI 仅监听本机，使用令牌保护，按 profile 显式启用，并受原生确认保护。
- AI 和 CLI 执行前会检查危险命令和敏感路径。
- 应用不发送遥测；唯一的自动网络请求是可关闭的公开 Release 检查。

详见[安全模型](docs/security.md)。

## 文档

| 主题 | 文档 |
| --- | --- |
| 功能说明 | [docs/features.md](docs/features.md) |
| CLI 和本地 API | [docs/cli.md](docs/cli.md) |
| Agent 执行规范 | [docs/agent-guide.md](docs/agent-guide.md) |
| 架构说明 | [docs/architecture.md](docs/architecture.md) |
| 开发 | [docs/development.md](docs/development.md) |
| 发布流程 | [docs/releasing.md](docs/releasing.md) |
| 变更记录 | [CHANGELOG.md](CHANGELOG.md) |

## 已知限制

- 正式发布支持 Windows x64；Linux 和 macOS 桌面构建仅是实验性 CI 产物。
- WebView2、托盘、系统凭据存储和文件关联在非支持版本上可能存在差异。
- 主机监控按 Linux 风格远程主机设计，Docker 工具通过 SSH 工作而不是本地 Docker Socket。
- ProxyJump 支持一层跳板机；终端分屏设计为同时显示两个终端。

## 许可证

gxShell 使用 [知识共享署名-非商业性使用-相同方式共享 4.0 国际许可协议](https://creativecommons.org/licenses/by-nc-sa/4.0/) 授权。
