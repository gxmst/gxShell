# gxShell 技术文档

## 项目概述

gxShell 是一款跨平台终端/SSH 客户端，集成了系统监控、文件管理、AI 辅助、Docker 管理、SSH 隧道等功能。采用 Go + React 架构，通过 Wails v2 框架将后端能力与前端界面桥接，打包为原生桌面应用。

---

## 技术栈

### 后端 (Go)

| 模块 | 技术 | 说明 |
|------|------|------|
| 框架 | Wails v2 | Go 桌面应用框架，提供 Go↔JS 桥接 |
| SSH | golang.org/x/crypto/ssh | SSH 连接、Shell 会话、命令执行 |
| SFTP | github.com/pkg/sftp | 远程文件传输 |
| 密钥存储 | github.com/zalando/go-keyring | 系统密钥环（Keyring）+ AES 加密回退 |
| 终端 | xterm.js v6 (WebGL) | 前端终端渲染，后端通过 SSH PTY 交互 |
| AI | OpenAI 兼容 API | 支持 DeepSeek、OpenAI 等，流式 SSE 响应 |
| Docker | SSH 远程执行 | 通过 SSH 执行 docker 命令管理容器 |
| 网络 | 原生 ICMP/UDP | Traceroute、Ping 诊断 |
| 配置 | JSON 文件 | 原子写入 + 备份容错 |

### 前端 (React + TypeScript)

| 模块 | 技术 | 说明 |
|------|------|------|
| 框架 | React 18 | 函数式组件 + Hooks |
| 构建 | Vite 3 | 快速构建 + HMR |
| 样式 | Tailwind CSS 3 | 原子化 CSS + 自定义主题 |
| 终端 | @xterm/xterm v6 + WebGL | GPU 加速终端渲染 |
| 图标 | lucide-react | 轻量 SVG 图标库 |
| Markdown | marked | AI 回复的 Markdown 渲染 |
| 国际化 | 自定义 i18n | 中/英双语支持 |

---

## 项目结构

```
gxShell/
├── main.go                  # 应用入口，Wails 配置
├── app.go                   # 核心桥接层，所有前端可调用的方法
├── backend/
│   ├── ai/                  # AI 模块：对话、工具调用、流式响应
│   ├── config/              # 配置存储：JSON 读写、原子写入
│   ├── docker/              # Docker 管理：容器列表、日志、启停
│   ├── localfs/             # 本地文件系统操作
│   ├── logger/              # 日志系统
│   ├── monitor/             # 系统监控：CPU/内存/磁盘/网络
│   ├── network/             # 网络诊断：Traceroute
│   ├── secrets/             # 密钥存储：Keyring + AES 加密
│   ├── sftp/                # SFTP 文件传输
│   ├── ssh/                 # SSH 会话管理
│   ├── tunnel/              # SSH 隧道（本地/远程/动态转发）
│   └── types/               # 共享类型定义
├── frontend/
│   ├── src/
│   │   ├── App.tsx          # 主应用组件
│   │   ├── components/      # UI 组件
│   │   │   ├── AiPanel/     # AI 对话面板
│   │   │   ├── ContainerPanel/  # Docker 容器面板
│   │   │   ├── MonitorPanel/    # 系统监控面板
│   │   │   ├── SftpPanel/       # SFTP 文件管理
│   │   │   ├── TerminalArea/    # 终端区域
│   │   │   ├── TunnelPanel/     # SSH 隧道面板
│   │   │   ├── FloatingTerminal/ # 浮动终端窗口
│   │   │   ├── SettingsPanel/   # 设置面板
│   │   │   └── modals/          # 各种弹窗
│   │   ├── hooks/           # 自定义 Hooks
│   │   ├── styles/          # CSS 样式
│   │   ├── utils/           # 工具函数
│   │   ├── i18n.ts          # 国际化
│   │   └── types.ts         # 前端类型定义
│   └── wailsjs/             # Wails 自动生成的绑定
└── doc/                     # 技术文档
```

---

## 核心功能实现

### 1. SSH 终端

**架构**：前端 xterm.js ↔ Wails 事件系统 ↔ Go SSH PTY

```
用户按键 → xterm.onData → Wails runtime → Go SSH stdin → 远程 Shell
远程输出 → Go SSH stdout → Wails EventsEmit → xterm.write → 终端渲染
```

**关键实现**：
- **PTY 会话管理**：`ssh/session.go` 维护最多 20 个并发 SSH 会话，每个会话独立管理 Shell、stdin/stdout
- **Host Key 安全策略**：实现 TOFU（Trust On First Use）机制，首次连接时弹出确认框，后续自动验证
- **终端自适应**：前端监听容器尺寸变化，通过 `ResizeTerminal` API 动态调整 PTY 大小，带防抖处理
- **WebGL 渲染**：使用 `@xterm/addon-webgl` 实现 GPU 加速渲染，大幅提升大数据量场景下的渲染性能
- **输出批量写入**：后端将 SSH 输出批量发送，前端批量写入 xterm，减少频繁渲染开销

### 2. SFTP 文件管理

**架构**：双面板文件管理器，本地/远程并列操作

**关键实现**：
- **双面板 UI**：`SftpDualPanel` 组件实现本地和远程文件列表并列显示，支持拖拽上传/下载
- **传输队列**：`useTransfers` Hook 管理传输队列，支持多文件并行传输和进度显示
- **路径安全**：`cleanRemotePath` 函数处理路径遍历攻击，规范化 `..` 等相对路径
- **目录缓存**：远程目录列表带缓存，减少重复请求

### 3. 系统监控

**架构**：后端定时采集 → 事件推送 → 前端实时渲染

**关键实现**：
- **数据采集**：`monitor/monitor.go` 通过 SSH 执行系统命令采集 CPU、内存、磁盘、网络、进程数据
- **可配置间隔**：监控间隔可在设置中调整，默认 3 秒
- **前端可视化**：`MonitorPanel` 使用 CSS 绘制实时图表，`MemoryCard`、`NetworkPathCard` 等组件展示关键指标
- **资源清理**：组件卸载时自动停止监控，防止 SSH 连接泄漏

### 4. AI 助手

**架构**：前端对话面板 ↔ Wails API ↔ Go HTTP 客户端 ↔ OpenAI 兼容 API

```
用户消息 → AiChat API → Go 构建请求 → HTTP POST → SSE 流式响应
                                                              ↓
AI 工具调用 → 前端显示 → 用户确认 → AiExecuteTool → SSH 执行命令
                                                              ↓
工具结果 → AiContinueChat → 自动继续对话 → AI 下一步操作
```

**关键实现**：

#### 4.1 流式响应解析
- **标准 SSE**：`parseSSE` 解析 OpenAI 格式的 `data: {...}` 流，累积 content 和 tool_calls
- **Ollama NDJSON**：`parseOllamaStream` 单独处理 Ollama 的非标准流式格式
- **DeepSeek 思考模式**：捕获 `reasoning_content` 字段，在继续对话时必须回传，否则 API 返回 400 错误

#### 4.2 工具调用
- **工具定义**：`execute_command`（执行 Shell 命令）和 `read_file`（读取远程文件）
- **用户确认机制**：工具调用在前端显示为可点击的 "Run" 按钮，用户确认后才执行
- **自动继续对话**：使用 `useEffect` 响应式检测工具执行完成状态，自动调用 `AiContinueChat` 继续 AI 对话
- **消息序列构建**：前端按 OpenAI API 要求的正确顺序构建消息序列（assistant + tool_calls → tool → assistant），确保 API 不会报 400 错误

#### 4.3 消息序列化
- **content: null 处理**：当 assistant 消息有 tool_calls 但无文字内容时，`content` 必须序列化为 `null` 而非空字符串 `""`
- **reasoning_content 回传**：DeepSeek 思考模式要求将之前的 `reasoning_content` 原样传回 API
- **手动 map 序列化**：后端将 `Message` 结构体转为 `map[string]any` 手动控制 JSON 输出，避免 Go 结构体零值导致的格式问题

#### 4.4 上下文注入
- **终端内容抓取**：通过 xterm buffer API（非 DOM 查询）获取终端最后 N 行内容，解决 WebGL 渲染模式下 DOM 无文本的问题
- **自动注入**：每条用户消息自动附加终端上下文，AI 可以"看到"用户当前的终端状态

### 5. Docker 管理

**架构**：通过 SSH 执行 docker 命令，前端展示容器列表和日志

**关键实现**：
- **容器列表**：`docker/manager.go` 执行 `docker ps -a --format json` 获取容器信息
- **命令注入防护**：`sanitizeDockerArg` 函数对容器 ID 进行正则校验，防止命令注入
- **流式日志**：`docker logs --follow` 通过 SSH 执行，后端持续读取输出并通过事件推送到前端
- **容器操作**：支持启动、停止、重启、删除容器

### 6. SSH 隧道

**架构**：基于 SSH 连接的端口转发

**关键实现**：
- **三种隧道类型**：
  - 本地转发（-L）：将本地端口转发到远程
  - 远程转发（-R）：将远程端口转发到本地
  - 动态转发（-D）：SOCKS 代理
- **生命周期管理**：`tunnel/tunnel.go` 管理隧道的启动、停止、重启
- **规则持久化**：隧道规则保存在 Profile 配置中，连接时自动启动

### 7. 密钥安全存储

**架构**：系统 Keyring 优先，AES 加密文件回退

**关键实现**：
- **Keyring 优先**：使用 `go-keyring` 库访问系统密钥环（Windows Credential Manager / macOS Keychain / Linux Secret Service）
- **AES 加密回退**：当 Keyring 不可用时，使用 AES-256-GCM 加密存储到本地文件
- **密钥派生**：使用 SHA-256 从机器 ID 派生加密密钥
- **安全擦除**：密码使用后尽快从内存中清除

### 8. 配置持久化

**架构**：JSON 文件 + 原子写入

**关键实现**：
- **原子写入**：先写入临时文件，再 rename 覆盖目标文件，避免写入中断导致数据损坏
- **备份容错**：JSON 解析失败时自动尝试 `.bak` 备份文件
- **默认值保障**：`ensureDefaults` 确保配置文件存在且格式正确
- **独立 AI 配置**：AI 配置使用专用的 `SaveAiConfig`/`GetAiConfig` API，避免嵌套对象序列化问题

### 9. 浮动终端

**架构**：DOM 移动 + 拖拽定位，模拟多窗口

**关键实现**：
- **标签拖出**：终端标签可拖出主区域，成为浮动面板
- **DOM 移动**：xterm 终端元素在主区域和浮动窗口之间动态移动
- **Wails v2 限制**：v2 不支持原生多窗口，采用浮动面板模拟独立窗口
- **位置/大小持久化**：浮动窗口的位置和大小保存到 localStorage

### 10. 国际化

**架构**：自定义轻量 i18n 方案

**关键实现**：
- **类型安全**：`LangKey` 联合类型确保所有翻译 key 都有对应的翻译
- **中/英双语**：`zh` 和 `en` 两个语言包
- **动态切换**：语言设置变更后立即生效，无需刷新

---

## 前端架构

### 自定义 Hooks

| Hook | 职责 |
|------|------|
| `useSessions` | SSH 会话管理：连接、断开、切换 |
| `useTerminal` | 终端生命周期：创建、销毁、输入输出 |
| `useSftp` | SFTP 操作：目录列表、上传、下载 |
| `useMonitor` | 监控数据采集和展示 |
| `useProfiles` | 服务器配置管理 |
| `useHotkeys` | 全局快捷键 |
| `useToasts` | 通知消息 |
| `usePersistedState` | 状态持久化到 localStorage |
| `useTransfers` | 文件传输队列管理 |

### 状态持久化

`usePersistedState` Hook 将 React 状态自动同步到 localStorage：

```tsx
const [drawer, setDrawer] = usePersistedState<Drawer>("gx:drawer", "monitor");
const [sidebarCollapsed, setSidebarCollapsed] = usePersistedState("gx:sidebarCollapsed", false);
```

### 组件通信

- **Props 向下传递**：父组件通过 props 传递回调和数据
- **Ref 稳定化**：使用 `useRef` 存储事件回调，避免闭包过期问题
- **事件系统**：Wails `EventsOn`/`EventsEmit` 实现后端到前端的实时通信

---

## 后端架构

### 模块化设计

每个后端模块独立封装，通过 `App` 结构体统一管理：

```go
type App struct {
    ctx     context.Context
    store   *config.Store
    log     *logger.Logger
    ssh     *sshmanager.Manager
    sftp    *sftpmanager.Manager
    monitor *monitor.Manager
    secrets *secrets.Store
    net     *network.Manager
    tunnels *tunnel.Manager
    ai      *ai.Manager
    docker  *docker.Manager
}
```

### 并发安全

- 所有 Manager 使用 `sync.RWMutex` 或 `sync.Mutex` 保护共享状态
- 统一使用 mutex，避免 atomic 和 mutex 混用导致的可见性问题
- SSH 会话使用 `sync.Once` 确保资源只清理一次

### 错误处理

- SSH `ExitError` 正确解析退出码，区分命令执行错误和系统错误
- 配置文件解析失败自动回退到备份
- AI API 错误包含结构化的消息摘要，便于调试

---

## 构建与部署

```bash
# 开发模式
wails dev

# 生产构建
wails build

# 输出
build/bin/gxShell.exe
```

### 构建产物

- Windows: `gxShell.exe`（内嵌前端资源）
- 前端资源通过 `//go:embed all:frontend/dist` 嵌入 Go 二进制
- Wails 自动生成 TypeScript 绑定（`wailsjs/` 目录）

---

## 已知限制

1. **Wails v2 不支持原生多窗口**：浮动终端通过 DOM 定位模拟，非真正独立窗口
2. **xterm WebGL 模式下 DOM 无文本**：终端内容抓取必须使用 buffer API
3. **AI 工具调用需要用户确认**：出于安全考虑，每次执行命令都需用户点击 Run
4. **Docker 管理依赖 SSH**：不支持本地 Docker socket 直连
5. **监控仅支持 Linux**：通过解析 `/proc` 文件系统采集数据
