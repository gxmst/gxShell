# gxShell

跨平台桌面 SSH 工作台，基于 Wails v2 + Go + React 构建，集成终端、监控、文件管理、AI 助手、Docker 管理和 SSH 隧道。

A cross-platform desktop SSH workbench built with Wails v2 + Go + React, integrating terminal, monitoring, file management, AI assistant, Docker management, and SSH tunnels.

---

## 功能特性 / Features

### SSH 终端 / SSH Terminal

- Go SSH 后端，交互式 PTY Shell 会话
- xterm.js v6 + WebGL GPU 加速渲染
- 多标签会话，最多 20 个并发连接
- 浮动终端窗口，标签可拖出为独立面板
- 终端分屏：水平/垂直分屏，可拖拽调整比例，同时查看两个终端
- 终端自适应尺寸，防抖调整 PTY 大小
- 右键复制/粘贴，搜索插件
- 输出高亮：三级模式（关闭 / 基础 / 完整），自动着色错误、警告、IP、路径等
- 密码和私钥认证，支持 passphrase
- Host Key TOFU（首次信任）策略，密钥变更自动拒绝
- SSH ProxyJump 跳板机：通过跳板机间接连接目标服务器，侧边栏跳板机标识
- 连接状态心跳：30 秒 SSH keepalive 探测，断线自动检测

### 系统监控 / System Monitor

- Linux 服务器 CPU、内存、磁盘、网络实时监控
- Top 进程列表
- 可配置采集间隔
- 后台 SSH 会话采集，不占用用户终端

### SFTP 文件管理 / SFTP File Manager

- 双面板 UI，本地/远程并列操作
- 拖拽上传/下载
- 传输队列，多文件并行传输和进度显示
- 远程文件：新建目录、重命名、删除
- 路径遍历攻击防护
- SFTP 客户端缓存 + 健康检查

### AI 助手 / AI Assistant

- 兼容 OpenAI API，支持 DeepSeek、OpenAI 等
- 流式 SSE 响应，实时显示
- DeepSeek 思考模式（reasoning_content）支持
- 工具调用：执行远程命令、读取远程文件
- 用户确认机制：工具调用需手动点击执行
- 自动上下文注入：将终端内容附加到对话
- API Key 脱敏存储，前端仅显示首尾 4 位

### Docker 管理 / Docker Management

- 容器列表、状态、镜像信息
- 流式日志查看（docker logs --follow）
- 启动、停止、重启、删除容器
- 命令注入防护（参数正则校验）

### SSH 隧道 / SSH Tunnels

- 本地端口转发（-L）
- 远程端口转发（-R）
- 动态转发 / SOCKS5 代理（-D）
- 隧道规则持久化，连接时自动启动

### 网络诊断 / Network Diagnostics

- Traceroute 路由追踪
- Ping 延迟测试
- 支持 Linux tracepath / traceroute / MTR 格式解析

### 安全特性 / Security

- 危险命令黑名单：AI 工具执行拦截 rm -rf /、mkfs、shutdown 等
- 敏感文件路径检查：禁止 AI 读取 /etc/shadow 等
- 密钥安全存储：系统 Keyring 优先，AES-256-GCM 加密文件回退
- 加密密钥由机器特征（hostname + homeDir）SHA256 派生，非明文存储
- AI Markdown 输出 DOMPurify 消毒，防止 XSS
- 日志自动脱敏：password、token 等字段 redact
- API Key 前端脱敏展示，保存时识别 masked key 不覆盖
- SSH ProxyJump 禁止嵌套跳板，防止循环引用；删除跳板机时级联清理引用

### 其他 / Others

- 中/英双语国际化
- 多主题支持（Light / Dark / Deep Blue / gx Dark）
- 终端主题、字体、行高、光标样式可配置
- 命令模板：可编辑的快捷命令面板
- 服务器配置 CRUD、复制、收藏、最近连接
- 配置原子写入 + 备份容错
- 本地日志文件，自动脱敏

---

## 技术栈 / Tech Stack

| 层 | 技术 |
|---|------|
| 桌面框架 | Wails v2（Go ↔ JS 桥接） |
| 后端 | Go 1.23+ |
| SSH | golang.org/x/crypto/ssh |
| SFTP | github.com/pkg/sftp |
| 密钥存储 | github.com/zalando/go-keyring + AES-256-GCM |
| AI | OpenAI 兼容 API（SSE 流式） |
| 前端 | React 18 + TypeScript |
| 构建 | Vite 3 |
| 样式 | Tailwind CSS 3 + 自定义主题 |
| 终端 | @xterm/xterm v6 + WebGL + Fit + Search |
| Markdown | marked + DOMPurify |
| 图标 | lucide-react |

---

## 项目结构 / Project Structure

```
gxShell/
├── main.go                  # 应用入口
├── app.go                   # 核心桥接层，前端可调用的所有方法
├── backend/
│   ├── ai/                  # AI 对话、工具调用、流式响应
│   ├── config/              # JSON 配置读写、原子写入
│   ├── docker/              # Docker 容器管理
│   ├── localfs/             # 本地文件系统操作
│   ├── logger/              # 日志系统
│   ├── monitor/             # 系统监控采集
│   ├── network/             # 网络诊断（Traceroute / Ping）
│   ├── secrets/             # 密钥安全存储
│   ├── sftp/                # SFTP 文件传输
│   ├── ssh/                 # SSH 会话管理
│   ├── tunnel/              # SSH 隧道
│   └── types/               # 共享类型定义
├── frontend/
│   ├── src/
│   │   ├── App.tsx          # 主应用组件
│   │   ├── components/      # UI 组件
│   │   ├── hooks/           # 自定义 Hooks
│   │   ├── styles/          # CSS 样式
│   │   ├── utils/           # 工具函数（高亮、格式化）
│   │   ├── i18n.ts          # 国际化
│   │   └── types.ts         # 前端类型
│   └── wailsjs/             # Wails 自动生成的绑定
└── doc/                     # 技术文档
```

---

## 开发 / Development

环境要求 / Prerequisites：

- Go 1.23+
- Node.js 18+ & npm
- Wails CLI v2
- Microsoft WebView2 Runtime

```powershell
wails doctor
go test ./...
cd frontend
npm install
npm run build
cd ..
wails build -clean
```

编译产物 / Output：

```
build/bin/gxShell.exe
```

---

## 已知限制 / Known Limitations

1. Wails v2 不支持原生多窗口，浮动终端通过 DOM 定位模拟
2. xterm WebGL 模式下 DOM 无文本，终端内容抓取使用 buffer API
3. AI 工具调用需要用户确认，不会自动执行命令
4. Docker 管理依赖 SSH，不支持本地 Docker socket
5. 系统监控仅支持 Linux（通过 /proc 文件系统采集）
6. 当前仅构建 Windows 版本
7. 终端分屏仅支持两个终端同时显示，不支持三栏或更多分屏
8. SSH ProxyJump 仅支持一级跳板，不支持嵌套跳板

---

## 安全说明 / Security Notes

- 服务器配置存储在 JSON 中，但密码和私钥 passphrase 不会写入 JSON
- 启用"保存密码"时，通过操作系统凭据管理器存储（Windows Credential Manager / macOS Keychain / Linux Secret Service）
- Keyring 不可用时，使用 AES-256-GCM 加密存储到本地文件，密钥由机器特征派生
- 旧版本明文密码会在启动时自动迁移
- SSH Host Key 存储在 `known_hosts` 文件，首次信任，变更拒绝
- AI 工具执行受危险命令黑名单和敏感路径检查保护
- API Key 在前端脱敏展示，保存时识别 masked key 不覆盖真实密钥
