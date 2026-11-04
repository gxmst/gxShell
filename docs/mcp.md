# MCP server

gxShell exposes the same seven tools over **stdio** and **Streamable HTTP**.
Claude Code, Codex and other clients that support these standard MCP transports
can use them. The implementation uses the official MCP Go SDK.

## Enable access

1. In gxShell settings, enable **CLI / MCP server** and restart the GUI.
2. Enable **Allow CLI / MCP access** on each server you want to expose and give
   it an alias. The tools list only opted-in aliases, never SSH credentials,
   host addresses or usernames.
3. Keep the GUI running. It owns SSH connections, native approvals, expiring
   trust and job state for both transports.

Both transports share the existing CLI access setting, which is off by default.
The HTTP endpoint is `http://127.0.0.1:56789/mcp`; no extra port is opened.
It is reachable only on the computer running gxShell. A cloud-hosted client
or a client on another machine cannot reach this loopback address.

## stdio

Configure the client to start the separate CLI binary with the `mcp` argument:

```text
gxshell-cli mcp
```

`--transport stdio` is optional. The process uses newline-delimited MCP JSON-RPC
on stdin/stdout, reads the local CLI token automatically, and calls the GUI's
existing authenticated API. Diagnostics go to stderr. No token needs to appear
in the client configuration.

Generate a configuration fragment using the CLI's actual executable path:

```powershell
.\gxshell-cli.exe mcp config --client claude --transport stdio
.\gxshell-cli.exe mcp config --client codex --transport stdio
```

The first prints JSON for Claude Code's `mcpServers`; the second prints a TOML
table for Codex. Merge the fragment into the appropriate client configuration.
Paths with spaces and Windows backslashes are escaped automatically. The
generator prints configuration only; it does not change client settings.
Register the service once in the client's global or project configuration.
New conversations in that scope load it automatically; setup is not per-chat.

For Claude Code, you can alternatively register the executable directly:

```powershell
claude mcp add --transport stdio gxshell -- <path-to-gxshell-cli.exe> mcp
```

Replace the angle-bracket placeholder with the real executable path and quote
it when it contains spaces.

## Streamable HTTP

Connect to `http://127.0.0.1:56789/mcp` with
`Authorization: Bearer <local-cli-token>`. The existing
`X-GxShell-CLI-Token` header is also accepted. Authentication applies to every
MCP HTTP request, including initialization and tool discovery.

The token is stored in the gxShell application configuration directory as
`cli_token` (`%APPDATA%\gxShell\cli_token` on Windows). Treat it as a local
automation credential. Do not paste its value into a prompt, source file or
shared project configuration.

Load it into the client process's environment without printing it:

```powershell
$mcpTokenPath = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'gxShell/cli_token'
$env:GXSHELL_MCP_TOKEN = (Get-Content -LiteralPath $mcpTokenPath -Raw).Trim()
```

Start the client from this environment. An already running desktop client
must be restarted with the environment variable available.

Generate the client configuration:

```powershell
.\gxshell-cli.exe mcp config --client claude --transport http
.\gxshell-cli.exe mcp config --client codex --transport http
```

Claude Code JSON:

```json
{
  "mcpServers": {
    "gxshell": {
      "type": "http",
      "timeout": 1860000,
      "url": "http://127.0.0.1:56789/mcp",
      "headers": {
        "Authorization": "Bearer ${GXSHELL_MCP_TOKEN}"
      }
    }
  }
}
```

Codex TOML:

```toml
[mcp_servers.gxshell]
url = "http://127.0.0.1:56789/mcp"
bearer_token_env_var = "GXSHELL_MCP_TOKEN"
tool_timeout_sec = 1860
```

The server returns stateless JSON responses under Streamable HTTP and supports
older MCP protocol revisions through SDK negotiation. It does not expose the
legacy HTTP+SSE transport or a separate `/sse` endpoint. Background job polling
provides incremental output. The endpoint enforces a 2 MiB request limit and
rejects cross-origin browser requests and non-localhost Host headers.

`gxshell-cli mcp --transport http` does not start a second listener: HTTP is
hosted directly in the running GUI.

## Tools and results

| Tool | Parameters | Purpose |
| --- | --- | --- |
| `gxshell_list_servers` | none | List opted-in server aliases |
| `gxshell_connection_status` | none | List active authorized SSH connections |
| `gxshell_execute_command` | `server`, `command` | Execute a single command |
| `gxshell_execute_script` | `server`, `script`, `shell` | Send a complete script over SSH stdin |
| `gxshell_job_status` | `jobId` | Get state and completed result without historical events |
| `gxshell_job_logs` | `jobId`, optional `after` | Poll ordered output; continue with `nextSequence` |
| `gxshell_cancel_job` | `jobId` | Request cancellation |

Both execution tools also accept `timeoutMs` (1000–1800000; default 120000),
`async`, `requestId` and `secrets`. `shell` must be `sh`, `bash`, `dash`, `zsh`
or `ksh`. Script text has UTF-8 BOM removal and newline normalization, and is
never embedded in a shell argument. Multiline commands and heredocs must use
`gxshell_execute_script`.

`secrets` maps environment names to references, such as
`{"API_KEY":"secret://service-api-key"}`. Only references are accepted; secret
values are not an MCP input. Named-secret execution is synchronous only.

Results are provided as both MCP `structuredContent` and JSON text content.
Inspect `outcome`, `exitCode`, `blocked`, `timedOut`, `riskTier`, `approval`,
`approvalStrength` and `remoteState`. Remote failures, blocked operations,
timeouts and validation errors set MCP `isError` while preserving these fields.

Every new execution generates a fresh `requestId`. To retry the same unchanged
request, pass its returned ID. Protection has the same bounded, in-process
30-minute retention as the CLI. Reusing an ID with different arguments is
rejected. There are no automatic execution retries. Transport failures return
the request ID when available; inspect remote state before retrying.

Long commands should use `async: true` to return a `jobId`, then poll logs and
state. The generated Codex configuration allows up to 31 minutes per tool
call; the Claude Code fragment sets the same limit in milliseconds. Other
clients may need their own timeout settings for synchronous work.
Cancellation acknowledges a request, not proof that remote processes stopped.
Jobs remain owned by the GUI when a client disconnects, and finished jobs are
retained for 30 minutes. File transfers and tunnels remain available through
the CLI; they are not included in this initial MCP tool catalog.

All execution uses the existing profile opt-in, risk classification, native
approval, expiring trust, secret handling and audit paths. The MCP protocol
does not grant extra privileges. Scripts and classifiers are not sandboxes.
See [agent-guide.md](agent-guide.md) for the execution contract and the CLI
guide for policy details (`docs/cli.md` in the source tree, `CLI-README.md` in
release archives).

Client documentation: [Claude Code](https://code.claude.com/docs/en/mcp) and
[Codex](https://developers.openai.com/codex/mcp/).
