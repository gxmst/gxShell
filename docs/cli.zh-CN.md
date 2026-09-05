# gxShell CLI 使用说明

`gxshell-cli.exe` 是可选的本机自动化工具。它让脚本或 AI Agent 通过正在运行的
gxShell 桌面应用，对用户明确授权的服务器执行命令；它不会直接读取已保存的 SSH
密码、私钥口令或真实主机信息。

仅仅在发布包里看到或保留这个文件，不会自动开启 CLI。gxShell 默认不启动 CLI
服务，也不会向 CLI 暴露任何服务器。如果不需要自动化功能，可以忽略或删除
`gxshell-cli.exe`。

## 启用方法

1. 启动 gxShell，打开“设置”。
2. 开启“启用 CLI 服务”，保存设置并重启 gxShell。
3. 编辑需要授权的服务器配置，开启“允许 CLI 访问”。
4. 设置一个不重复的 CLI 别名，例如 `prod-web`。
5. 在 PowerShell 中进入解压目录，先执行诊断和列表命令：

```powershell
.\gxshell-cli.exe doctor
.\gxshell-cli.exe ping
.\gxshell-cli.exe list
```

关闭设置中的“启用 CLI 服务”并重启 gxShell 后，本机监听器不会启动，CLI 将完全
不可用；关闭单个服务器的“允许 CLI 访问”则只撤销该服务器的授权。

## 常用命令

```powershell
# 查看 CLI 可访问的服务器别名
.\gxshell-cli.exe list

# 查看已连接的 CLI 会话
.\gxshell-cli.exe status

# 执行命令；建议自动化调用始终使用结构化 JSON
.\gxshell-cli.exe exec prod-web "uptime" --json

# 长任务可显式增加超时时间
.\gxshell-cli.exe exec prod-web "journalctl -u nginx -n 200" --timeout 10m --json

# 多行脚本必须使用 exec-file 或 exec-stdin，并明确指定 shell
.\gxshell-cli.exe exec-file prod-web .\check.sh --shell bash --json
Get-Content .\check.sh -Raw | .\gxshell-cli.exe exec-stdin prod-web --shell bash --json

# 单文件上传和下载；覆盖已有文件必须额外提供 --overwrite
.\gxshell-cli.exe transfer push .\app.tar.gz prod-web:/srv/app/app.tar.gz --mkdir --json
.\gxshell-cli.exe transfer pull prod-web:/srv/app/app.log .\downloads\app.log --json
```

运行 `.\gxshell-cli.exe help` 或具体命令的 `--help` 可查看完整参数。英文完整参考见
同目录的 `CLI-README.md`；AI Agent 在使用前还必须阅读 `agent-guide.md`。

## 安全边界

- CLI 服务只监听 `127.0.0.1:56789`，并使用 gxShell 生成的本机令牌认证。
- CLI 只返回用户设置的别名，不返回主机名、IP、用户名、端口、配置 ID 或跳板机信息。
- 每个服务器都必须单独开启“允许 CLI 访问”，默认不会暴露任何服务器。
- 外部 CLI 命令按可见行为分为 T0-T3：T0 只读观测不询问；T1 是范围明确、可恢复的
  变更；T2 是有界破坏、不透明执行或外部操作；T3 是不可逆、自锁、凭据或公开操作。
- “限时自动化信任”持续 1、4、8 或 24 小时，自动放行 T1 以及影响局部的有界 T2 操作；
  不透明或跨系统的 T2 始终需要点击原生框；T3 不进入批量“全部允许”，无论是否信任，
  每条命令都必须单独点击确认。
- 任何需要确认的命令，原生框都会在命令下方显示一段根据已识别行为和目标生成的简短
  “作用说明”。它只帮助用户快速理解，不代表分类器能够证明命令安全；不透明或伪装执行
  仍至少按 T2 处理。
- 远程复制/传输仍有独立的敏感路径限制；内置 AI 助手仍使用原有的已知模式预检。外部
  CLI 的 `exec` 不再把永久命令黑名单当作安全边界。
- 本地文件传输只支持单个普通文件，默认禁止覆盖；不要把密码或令牌直接放进命令行、
  脚本参数、提示词或日志，优先使用 CLI 的命名 secret 功能。
- CLI 创建的本地转发或 SOCKS 隧道是临时资源，只允许绑定回环地址；任务结束后应主动
  关闭并用 `tunnel list` 确认没有遗留。

## AI Agent 使用要求

自动化工具必须把 CLI 别名作为唯一目标身份，先用小型只读命令确认目标，再执行有副
作用的操作。多行脚本必须通过 `exec-file` 或 `exec-stdin` 传输，不能把 heredoc 塞进
普通 `exec` 参数。请检查 JSON 中的 `outcome`、`errorKind`、`blockedBy`、`exitCode`、
`timedOut`、`truncated`、`riskTier`、`riskCategories`、`approval` 和
`approvalStrength`，不要只根据进程退出码猜测远端状态。最终授权只来自原生框；应用内
彩色风险卡只是同步说明，不能单独授权。

### 脚本不是安全边界

`exec-file` 和 `exec-stdin` 只是脚本传输方式，不是沙箱。风险分类器只能分析可见文本，
无法判断任意 Python、Node、Perl、Ruby、`awk`、构建钩子、编译后的程序或解码后载荷
实际会做什么。

AI Agent 不得用其他程序把被禁止的操作改头换面，包括：

- 上传或生成脚本后再执行；
- 使用解释器的 `-c`、`-e` 参数或 `sh -c` 等包装器；
- 先下载、解码、解压、编译代码再运行；
- 用库函数或系统 API 掩盖本应更高档审批、或用户并未授权的操作。

文件传输的确认只覆盖“移动文件”，不覆盖“执行文件”。限时自动化信任自动放行 T1 与影
响局部的有界 T2 操作；解释器、上传脚本和其他不透明执行属于无法判定的 T2，仍会弹
框。这个机制约束的是守规矩的
自动化，不是对恶意 token 持有者或刻意伪装程序的隔离。只有在用户明确授权了完整源码、
目标、副作用、网络去向和 secret 使用方式时，才能执行这类脚本；优先使用可检查的
单条命令或专用 CLI 操作。

JSON 中的 `blocked: false` 只表示 gxShell 没有停止这次请求，不表示操作只读、无害或
已经经过完整审查。

完整的模型无关执行规范见同目录的 `agent-guide.md`。

## 常见问题

- `gxShell daemon is not running`：确认 gxShell 正在运行、CLI 服务已开启，并在改动后重启应用。
- `No CLI-enabled servers configured`：至少为一个服务器开启“允许 CLI 访问”并设置别名。
- `server "<alias>" is not available to CLI`：检查别名拼写和该服务器的 CLI 授权。
- 只能在解压目录运行：执行 `doctor`，再按其提示把可执行文件所在目录加入 `PATH`。
- 远端命令超时：先检查远端进程、服务或容器的实际状态，再决定是否重试；不要假设超时
  等于命令完全没有执行。
