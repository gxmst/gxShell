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
- 简单只读命令可以直接执行；其他命令默认会在 gxShell 中弹出原生确认对话框。
- 危险命令和敏感路径会在确认前被硬拦截，但这些规则不是完整沙箱，不能替代人工审查。
- “限时完全信任”会在 1、4、8 或 24 小时内跳过部分命令和远程复制确认。只应在受控
  工作流中短时开启；密钥变更、本地文件传输和临时隧道仍有额外确认或限制。
- 本地文件传输只支持单个普通文件，默认禁止覆盖；不要把密码或令牌直接放进命令行、
  脚本参数、提示词或日志，优先使用 CLI 的命名 secret 功能。
- CLI 创建的本地转发或 SOCKS 隧道是临时资源，只允许绑定回环地址；任务结束后应主动
  关闭并用 `tunnel list` 确认没有遗留。

## AI Agent 使用要求

自动化工具必须把 CLI 别名作为唯一目标身份，先用小型只读命令确认目标，再执行有副
作用的操作。多行脚本必须通过 `exec-file` 或 `exec-stdin` 传输，不能把 heredoc 塞进
普通 `exec` 参数。请检查 JSON 中的 `outcome`、`errorKind`、`blockedBy`、`exitCode`、
`timedOut` 和 `truncated`，不要只根据进程退出码猜测远端状态。

完整的模型无关执行规范见同目录的 `agent-guide.md`。

## 常见问题

- `gxShell daemon is not running`：确认 gxShell 正在运行、CLI 服务已开启，并在改动后重启应用。
- `No CLI-enabled servers configured`：至少为一个服务器开启“允许 CLI 访问”并设置别名。
- `server "<alias>" is not available to CLI`：检查别名拼写和该服务器的 CLI 授权。
- 只能在解压目录运行：执行 `doctor`，再按其提示把可执行文件所在目录加入 `PATH`。
- 远端命令超时：先检查远端进程、服务或容器的实际状态，再决定是否重试；不要假设超时
  等于命令完全没有执行。
