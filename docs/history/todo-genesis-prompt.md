我要开发一个桌面端 SSH 服务器管理工具，项目名叫 gxShell。

请你作为资深全栈桌面应用架构师、Go 后端工程师、React 前端工程师和产品设计师，帮我从零开发这个项目。

项目目标：
做一个类似 FinalShell / Xshell / MobaXterm 的轻量现代版 SSH 客户端，但不要照搬它们的 UI。gxShell 的定位是：
一个轻量、现代、美观、运行快、适合个人开发者和小团队使用的 SSH 服务器工作台。

核心要求：
1. 不使用 Electron。
2. 不使用 Tauri。
3. 技术栈固定为：
   - Wails
   - Go
   - React
   - TypeScript
   - xterm.js
   - Tailwind CSS
4. 后端用 Go 处理 SSH、SFTP、状态采集、本地配置读写。
5. 前端用 React + TypeScript 做现代化 UI。
6. 终端渲染必须使用 xterm.js。
7. 打包目标优先支持 Windows，后续兼容 macOS 和 Linux。
8. 代码结构要清晰，适合新手维护，也适合后续继续让 AI 修改。
9. 不要引入过度复杂的架构，不要一开始使用微服务、插件系统、复杂数据库。
10. 本地配置第一阶段使用 JSON 文件存储即可，后续预留迁移 SQLite 的空间。

==================================================
一、产品整体设计
==================================================

gxShell 使用左右两栏布局，不要使用 FinalShell 那种拥挤、老旧、上下多面板堆叠的 UI。

整体布局：

- 顶部栏：
  - gxShell Logo / 名称
  - 新建连接按钮
  - 全局搜索入口
  - 设置入口
  - 主题切换入口
  - 当前版本信息入口

- 左侧边栏：
  - 服务器分组
  - 服务器列表
  - 收藏服务器
  - 最近连接
  - 当前选中服务器的简要状态
  - 快捷操作按钮：连接、断开、重连、打开 SFTP、打开快捷命令

- 右侧主区域：
  - 顶部是多 Tab 栏
  - 下方是大面积终端区域
  - 终端区域必须是视觉主角
  - 尽量不要堆过多按钮和杂乱面板

整体视觉风格：
- 现代
- 深色优先
- 简洁
- 高级感
- 类似 VS Code / Warp / Tabby / Linear 的风格
- 不要像传统 Windows 工具
- 不要像 FinalShell 那样信息密度过高
- 圆角适中
- 留白合理
- 终端字体要舒服

==================================================
二、核心功能模块
==================================================

请按照以下模块设计项目结构：

1. 服务器配置管理模块 ServerProfile
2. SSH 连接管理模块 SSHManager
3. 终端会话管理模块 TerminalSessionManager
4. 多 Tab 管理模块 TabManager
5. 服务器状态采集模块 ServerMonitor
6. SFTP 文件管理模块 SftpManager
7. 快捷命令模块 CommandPalette
8. 终端主题模块 TerminalThemeManager
9. 本地配置存储模块 ConfigStore
10. 应用设置模块 AppSettings
11. 日志模块 AppLogger

==================================================
三、服务器配置管理
==================================================

需要支持创建、编辑、删除、保存服务器配置。

服务器配置字段：

- id
- name
- group
- host
- port
- username
- authType: password / privateKey
- password
- privateKeyPath
- privateKeyPassphrase
- description
- tags
- favorite
- lastConnectedAt
- createdAt
- updatedAt

第一阶段密码可以先保存在本地 JSON，但代码中必须封装存储层，后续方便替换成系统 Keychain / Windows Credential Manager。

服务器列表功能：
- 新建服务器
- 编辑服务器
- 删除服务器
- 复制服务器配置
- 按分组显示
- 收藏显示
- 最近连接显示
- 搜索服务器
- 双击服务器直接连接
- 当前活动服务器高亮
- 在线 / 离线状态标记

==================================================
四、SSH 终端功能
==================================================

必须实现真正可交互的 SSH 终端，而不是简单执行单条命令。

要求：
1. Go 后端建立 SSH 连接。
2. 为用户终端创建独立交互式 shell session。
3. 前端 xterm.js 显示终端输出。
4. 前端输入实时传给 Go 后端。
5. Go 后端实时把 SSH stdout/stderr 转发给前端。
6. 支持 Ctrl+C、Ctrl+D、方向键、Tab 补全、vim、nano、top、htop、less、tmux 等交互式程序。
7. 支持终端 resize，窗口变化时同步调整远程 PTY 大小。
8. 支持多 Tab，每个 Tab 一个独立 SSH 会话。
9. 支持断开连接。
10. 支持重连。
11. 支持连接状态显示。
12. Tab 上显示绿色/灰色/黄色状态点：
    - 绿色：已连接
    - 黄色：连接中/重连中
    - 灰色：已断开
    - 红色：连接错误

终端右键菜单：
- 复制
- 粘贴
- 清屏
- 重新连接
- 断开连接
- 搜索
- 打开当前路径的 SFTP 面板

终端快捷键：
- Ctrl+Shift+C：复制
- Ctrl+Shift+V：粘贴
- Ctrl+L：清屏
- Ctrl+F：搜索
- Ctrl+T：新建 Tab
- Ctrl+W：关闭当前 Tab

==================================================
五、xterm.js 终端美化
==================================================

终端必须支持 ANSI escape code，不允许破坏远程命令原始输出。

不要对 SSH 输出流直接做正则替换插入颜色，因为这样可能破坏 vim、top、tmux 等程序。

第一阶段需要实现：
1. xterm.js 基础渲染
2. ANSI 颜色支持
3. 终端主题切换
4. 字体设置
5. 字号设置
6. 行高设置
7. 光标样式设置
8. 终端透明度设置
9. Ctrl+F 搜索高亮

内置主题：
- gx Dark
- Nord
- Dracula
- Tokyo Night
- Monokai
- Solarized Dark

终端字体建议支持：
- JetBrains Mono
- Fira Code
- Cascadia Code
- MesloLGS NF
- Maple Mono
- 系统等宽字体 fallback

终端设置字段：
- fontFamily
- fontSize
- lineHeight
- cursorStyle
- cursorBlink
- themeName
- backgroundOpacity
- scrollbackLines

==================================================
六、智能高亮 Smart Highlight
==================================================

预留 Smart Highlight 模块，但注意不要破坏原始终端输出。

实现原则：
1. 默认以安全模式实现。
2. 不直接修改 SSH 输出流。
3. 尽量基于 xterm.js 显示层 addon / marker / decoration 实现。
4. 检测到 vim、nano、top、htop、less、man、tmux 等全屏程序时，自动暂停智能高亮。
5. 用户可以在设置里打开或关闭 Smart Highlight。

高亮规则：
- error / failed / fatal / denied：红色强调
- warning / warn / deprecated：黄色强调
- success / done / ok：绿色强调
- IP 地址：蓝色
- URL：可点击
- 文件路径：可点击或可复制
- 端口号：轻微高亮
- git / docker / npm / pnpm / bun / systemctl 等常见命令：可选高亮

第一阶段先实现 Ctrl+F 搜索高亮。
Smart Highlight 可以先设计接口和结构，不要求一次全部实现。

==================================================
七、服务器状态监控
==================================================

左侧边栏需要显示当前连接服务器的简要状态。

注意：
监控命令绝对不能发到用户正在操作的终端 session 里。
不能污染用户的终端输出。
不能让用户执行 history 时看到一堆监控命令。

正确实现：
SSH 连接中单独创建后台 exec session。
后台 session 不 RequestPty，不 Shell，只使用 session.Run(command) 执行监控命令。
执行完拿 stdout，解析结果，发给前端状态栏。

状态采集内容：
- 在线状态
- IP / Host
- 系统运行时间 uptime
- Load average
- CPU 使用率
- 内存使用量 / 总量 / 百分比
- Swap 使用量 / 总量 / 百分比
- 根目录磁盘使用量 / 总量 / 百分比
- 网络上传 / 下载速度
- 延迟 ping 或简单连接耗时
- Top 进程列表，按 CPU 或内存排序

采集频率建议：
- 当前正在查看的 Tab：每 3~5 秒采集一次
- 后台打开但未激活的 Tab：每 15~30 秒采集一次
- 未连接服务器：不采集
- 磁盘信息：10~30 秒一次即可
- 进程列表：5~10 秒一次即可

第一阶段可以统一每 5 秒采集一次基础信息。

Linux 监控命令建议：
- cat /proc/loadavg
- free -m
- df -h /
- cat /proc/stat
- cat /proc/meminfo
- cat /proc/net/dev
- uptime -p
- ps aux --sort=-%mem | head

CPU 使用率：
通过两次读取 /proc/stat 计算差值，不要只读一次。

网络速度：
通过两次读取 /proc/net/dev 计算字节差值，得到上传/下载速度。

左侧状态 UI：
- 在线状态点
- 运行时间
- CPU 百分比进度条
- 内存百分比进度条
- 磁盘百分比进度条
- Load average
- 网络上行/下行
- Top 进程简表

状态栏要求简洁，不要做成复杂监控平台。

==================================================
八、SFTP 文件管理
==================================================

需要实现内置 SFTP 文件管理器。

SFTP 不要默认占用底部大块空间。
建议通过以下方式打开：
- 左侧服务器快捷按钮打开
- 当前 Tab 右键打开
- 终端右键菜单打开
- 独立文件管理 Tab 打开
- 或右侧抽屉面板打开

SFTP 功能：
1. 显示远程当前目录
2. 显示文件列表
3. 显示文件名、大小、类型、修改时间、权限、用户/用户组
4. 双击文件夹进入
5. 返回上级目录
6. 刷新目录
7. 上传文件
8. 下载文件
9. 删除文件
10. 重命名文件
11. 新建文件夹
12. 修改权限 chmod，后续可做
13. 复制远程路径
14. 在终端中 cd 到该路径，后续可做

文件管理 UI：
- 左侧目录树
- 右侧文件列表
- 顶部路径栏
- 上传/下载/刷新按钮
- 传输进度条
- 失败提示
- 覆盖确认

第一阶段可以不做本地/远程双栏同步。
先做远程文件浏览、上传、下载、删除、重命名。

==================================================
九、快捷命令功能
==================================================

需要内置快捷命令面板。

用户可以保存常用命令，一键发送到当前终端。

命令字段：
- id
- name
- command
- category
- description
- tags
- createdAt
- updatedAt

内置命令模板：
- 查看磁盘：df -h
- 查看内存：free -h
- 查看负载：uptime
- 查看 Docker 容器：docker ps
- 查看 Docker 镜像：docker images
- 查看 Nginx 状态：systemctl status nginx
- 查看服务状态：systemctl status <service>
- 查看日志：tail -f /var/log/syslog
- 查看端口：ss -tunlp
- 查看进程：ps aux --sort=-%mem | head

要求：
1. 快捷命令点击后发送到当前终端。
2. 支持编辑命令。
3. 支持分类。
4. 支持搜索。
5. 支持变量占位符，后续可做，例如 <service>。

==================================================
十、多 Tab 和分屏
==================================================

多 Tab 是必须功能。

Tab 要求：
- 一个 Tab 对应一个 SSH 会话
- Tab 显示服务器名称
- Tab 显示连接状态点
- 支持关闭 Tab
- 支持重命名 Tab
- 支持重新连接
- 支持拖拽排序，后续可做
- 支持新建 Tab
- 支持关闭其他 Tab
- 支持关闭右侧 Tab

分屏功能作为高级功能：
- 支持左右分屏
- 支持上下分屏
- 每个分屏一个终端 session
- 可以后续实现，但项目结构要预留空间

==================================================
十一、本地配置和数据存储
==================================================

第一阶段使用 JSON 文件存储配置。

需要存储：
- 服务器配置
- 应用设置
- 终端主题设置
- 快捷命令
- 最近连接
- 窗口大小
- 左侧栏宽度
- 用户偏好设置

建议文件结构：
gxShell data directory:
- profiles.json
- settings.json
- commands.json
- themes.json
- recent.json
- logs/

注意：
存储路径要使用系统推荐的应用数据目录，不要硬编码到项目目录。

后续预留 SQLite：
请把 ConfigStore 抽象出来，不要让 UI 直接读写 JSON。

==================================================
十二、安全要求
==================================================

第一阶段可以先用 JSON 保存密码，但代码层面必须清楚标记 TODO，后续替换为系统安全存储。

后续安全方向：
- Windows Credential Manager
- macOS Keychain
- Linux Secret Service
- 私钥 passphrase 不明文长期保存
- 支持不保存密码，只连接时输入
- 支持配置文件导入导出时隐藏密码

SSH 安全：
- 支持 password 登录
- 支持 private key 登录
- 支持 known_hosts 校验，后续可做
- 首次连接提示 host key，后续可做
- 支持连接超时设置
- 支持 keepalive

==================================================
十三、错误处理
==================================================

必须有清晰错误提示，不要只在控制台打印。

常见错误：
- 连接超时
- 认证失败
- Host 不可达
- 端口错误
- 私钥错误
- 密码错误
- SFTP 权限不足
- 文件不存在
- 上传失败
- 下载失败
- SSH session 已断开
- 远程命令执行失败

前端需要显示 toast / dialog / 状态提示。

日志模块：
- 后端记录关键错误
- 前端可打开日志面板
- 日志不要记录明文密码

==================================================
十四、项目目录结构建议
==================================================

请按照类似结构生成项目：

gxShell/
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── layout/
│   │   │   ├── sidebar/
│   │   │   ├── terminal/
│   │   │   ├── tabs/
│   │   │   ├── sftp/
│   │   │   ├── monitor/
│   │   │   ├── commands/
│   │   │   └── settings/
│   │   ├── pages/
│   │   ├── stores/
│   │   ├── types/
│   │   ├── utils/
│   │   ├── styles/
│   │   └── App.tsx
│   ├── package.json
│   └── tailwind.config.js
│
├── backend/
│   ├── ssh/
│   ├── sftp/
│   ├── monitor/
│   ├── config/
│   ├── commands/
│   ├── logger/
│   └── types/
│
├── app.go
├── main.go
├── wails.json
└── README.md

也可以根据 Wails 默认结构调整，但必须保持模块清晰。

==================================================
十五、Go 后端接口设计
==================================================

请设计 Wails 暴露给前端的方法，例如：

服务器配置：
- ListProfiles()
- CreateProfile(profile)
- UpdateProfile(profile)
- DeleteProfile(id)
- GetProfile(id)

SSH：
- Connect(profileId)
- Disconnect(sessionId)
- Reconnect(sessionId)
- WriteToTerminal(sessionId, data)
- ResizeTerminal(sessionId, cols, rows)

SFTP：
- ListRemoteDir(sessionId, path)
- UploadFile(sessionId, localPath, remotePath)
- DownloadFile(sessionId, remotePath, localPath)
- DeleteRemoteFile(sessionId, path)
- RenameRemoteFile(sessionId, oldPath, newPath)
- CreateRemoteDir(sessionId, path)

Monitor：
- StartMonitor(sessionId)
- StopMonitor(sessionId)
- GetLatestMetrics(sessionId)

Commands：
- ListCommands()
- CreateCommand(command)
- UpdateCommand(command)
- DeleteCommand(id)
- SendCommandToTerminal(sessionId, command)

Settings：
- GetSettings()
- UpdateSettings(settings)

前端和后端事件：
- terminal:data
- terminal:connected
- terminal:disconnected
- terminal:error
- monitor:update
- sftp:progress
- app:error

==================================================
十六、前端状态管理
==================================================

前端需要管理：
- 服务器列表
- 当前选中服务器
- 打开的 tabs
- 当前 active tab
- 每个 tab 的连接状态
- 每个 tab 对应的 terminal instance
- 当前服务器 metrics
- SFTP 当前路径和文件列表
- 快捷命令列表
- 应用设置

可以使用 Zustand 或 React Context。
优先保持简单，不要引入 Redux 这种复杂方案。

==================================================
十七、UI 细节要求
==================================================

左侧边栏：
- 宽度 260~320px
- 可拖动调整宽度
- 可折叠
- 服务器列表支持搜索
- 当前服务器高亮
- 在线状态点
- 收藏星标

终端区域：
- 黑色/深蓝背景
- 字体清晰
- 滚动顺滑
- 支持复制粘贴
- 支持右键菜单
- 支持搜索

状态卡片：
- CPU / 内存 / 磁盘使用进度条
- 网络上下行小标签
- 负载小标签
- Top 进程简表
- 不要做太拥挤

SFTP：
- 文件列表要清爽
- 文件夹和文件图标区分
- 上传下载进度清晰
- 错误提示明确

设置页：
- 终端主题
- 字体
- 字号
- 行高
- 光标
- 默认连接超时
- 是否开启服务器状态监控
- 状态采集间隔
- 是否开启 Smart Highlight

==================================================
十八、开发方式要求
==================================================

请你不要一次性只讲概念。
请按照工程落地方式输出。

我希望你按以下顺序工作：

第一步：
输出完整项目架构说明和目录结构。

第二步：
生成 Wails 项目初始化命令。

第三步：
生成 Go 后端核心结构：
- Profile 类型
- SSH Session 类型
- SSHManager
- ConfigStore
- Monitor 基础结构

第四步：
生成 React 前端基础界面：
- App 布局
- 左侧 Sidebar
- TabBar
- TerminalView
- ServerStatusPanel
- Settings 基础页

第五步：
实现 SSH 连接和 xterm.js 交互。

第六步：
实现多 Tab。

第七步：
实现服务器状态监控。

第八步：
实现 SFTP 文件管理。

第九步：
实现快捷命令。

第十步：
实现主题和设置。

每一步都要给出：
- 需要创建/修改的文件
- 完整代码
- 运行命令
- 如何测试
- 常见错误和修复方式

==================================================
十九、重要限制
==================================================

1. 不要使用 Electron。
2. 不要使用 Tauri。
3. 不要把状态监控命令写入用户当前终端。
4. 不要用正则直接污染 SSH 输出流做高亮。
5. 不要一开始引入复杂数据库。
6. 不要做过度复杂的插件系统。
7. 不要生成只有伪代码的方案，要尽量给真实可运行代码。
8. 代码要尽量清晰，函数命名明确，方便我这个新手理解。
9. 遇到复杂功能时，先实现稳定版本，再预留高级能力。
10. UI 不要照抄 FinalShell，要做现代化的 gxShell 风格。

==================================================
二十、最终目标
==================================================

最终希望 gxShell 拥有以下能力：

- 轻量桌面端 SSH 客户端
- 左右两栏现代 UI
- 多服务器配置管理
- 多 Tab SSH 终端
- xterm.js 高质量终端渲染
- 终端主题和字体自定义
- 服务器状态监控
- SFTP 文件管理
- 快捷命令面板
- 搜索高亮
- Smart Highlight 预留
- 连接/断开/重连
- 本地配置保存
- 后续可扩展密钥登录、安全存储、分屏、端口转发
