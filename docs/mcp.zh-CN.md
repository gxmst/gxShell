# MCP 接入

gxShell 同时提供 **stdio** 和 **Streamable HTTP** 两种标准 MCP 入口，
工具和授权行为一致。Claude Code、Codex 及支持这两种传输的其他客户端均可接入。

## 启用

1. 在 gxShell 设置中开启「CLI / MCP 服务」，保存并重启桌面程序。
2. 对需要开放的服务器启用「允许 CLI / MCP 访问」，并设置别名。
3. 使用期间保持 gxShell 运行。SSH 连接、原生审批、限时信任和后台任务均由它管理。

两种入口沿用同一个开关，默认关闭。HTTP 地址是
`http://127.0.0.1:56789/mcp`，复用已有本机端口，不增加额外监听。
此地址只能由同一台电脑上的客户端访问；其他电脑和云端客户端不能直接连接。

## stdio：本机配置最简单

客户端启动 `gxshell-cli mcp`，通过标准输入／输出进行 MCP 通信。
CLI 自动读取本机令牌，配置中不需要填写令牌。

```powershell
.\gxshell-cli.exe mcp config --client claude --transport stdio
.\gxshell-cli.exe mcp config --client codex --transport stdio
```

命令分别输出 Claude Code 的 JSON 配置或 Codex 的 TOML 配置，自动使用该 CLI
的实际路径并处理空格与反斜杠。将片段合入客户端配置即可；命令不会自动修改配置。
在客户端的全局或项目配置中注册一次，同一范围的新对话会自动加载，不必逐个
对话重新配置。

Claude Code 也可以直接注册，记得替换并按需引用实际程序路径：

```text
claude mcp add --transport stdio gxshell -- <实际的gxshell-cli路径> mcp
```

## HTTP：多个客户端共享入口

客户端连接 `http://127.0.0.1:56789/mcp`，每个请求都需要 Bearer 令牌。
令牌沿用 Windows 上 `%APPDATA%\gxShell\cli_token`。将它加载到环境变量，
避免将真实令牌放进提示词、命令参数或共享配置：

```powershell
$mcpTokenPath = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'gxShell/cli_token'
$env:GXSHELL_MCP_TOKEN = (Get-Content -LiteralPath $mcpTokenPath -Raw).Trim()
.\gxshell-cli.exe mcp config --client claude --transport http
.\gxshell-cli.exe mcp config --client codex --transport http
```

从这个环境启动客户端。已经运行的桌面客户端需要在能够继承该变量的环境中重启。
生成的配置只包含环境变量引用，不包含真实令牌。

HTTP 采用 Streamable HTTP 的无状态 JSON 响应，不提供旧版独立 `/sse` 入口。
使用官方 MCP Go SDK 协商协议版本；输入限制为 2 MiB，并检查跨站来源和本机 Host。
无需另外运行 HTTP CLI 进程，服务已集成在 gxShell 桌面程序中。

## 首批工具

| 工具 | 用途 |
| --- | --- |
| `gxshell_list_servers` | 列出已授权别名，不暴露 SSH 凭据、地址或用户名 |
| `gxshell_connection_status` | 查询已授权服务器的活动连接 |
| `gxshell_execute_command` | 执行单行命令 |
| `gxshell_execute_script` | 传输完整多行脚本，明确指定 shell |
| `gxshell_job_status` | 查询后台任务状态 |
| `gxshell_job_logs` | 按序号增量获取输出 |
| `gxshell_cancel_job` | 请求取消任务 |

执行工具支持超时、异步任务、请求编号及 `secret://` 引用。多行脚本和 heredoc
必须使用 `gxshell_execute_script`；shell 可选 `sh`、`bash`、`dash`、`zsh`、`ksh`。
长任务建议设置 `async: true`，拿到 `jobId` 后查询日志和状态。

结果同时包含结构化内容和 JSON 文本。关注 `outcome`、`exitCode`、`blocked`、
`timedOut`、`remoteState` 及审批字段；失败时 MCP `isError` 会置为 true。
每次新执行自动生成请求编号；重试同一份参数时保留 `requestId`，沿用 CLI 的
进程内 30 分钟去重规则。超时或取消不证明远程进程停止，不能盲目重试。

所有操作沿用现有授权和审计路径。第一版没有将文件传输、隧道和密钥写入开放为
MCP 工具，这些仍可通过 CLI 使用。完整参数、配置示例和限制见
[英文参考](mcp.md)，执行规范见 [Agent 使用规范](agent-guide.md)。
