---
name: gxshell
description: Use gxshell-cli to inspect or administer servers authorized in the gxShell desktop app, execute remote scripts, transfer files, or manage temporary SSH tunnels by server alias. Use for remote work through gxShell, not for developing gxShell itself or configuring unrelated SSH clients.
---

# gxShell remote operations

Use the running gxShell desktop app's saved connections through `gxshell-cli`.
Targets are CLI-enabled server aliases, not hostnames or credentials supplied by
the app. Keep the user's requested targets and operations explicit.

Before remote operations, read [the agent contract](references/agent-guide.md).
For command flags, file transfers, jobs or tunnels, consult
[the CLI reference](references/cli.md). These bundled references come from the
project's maintained documentation and travel with the installed skill.

## Establish access and target identity

The skill supplies instructions; gxShell and `gxshell-cli` must be installed
separately. Locate the CLI on `PATH` or use its known full path. In PowerShell,
an executable in the current directory needs `./gxshell-cli.exe`; a quoted full
path needs the call operator `&`.

The user must enable **CLI / MCP server** in gxShell Settings, restart the app,
and enable access with an alias on each intended server. Keep gxShell running.
Check access without exposing the local authentication token:

```sh
gxshell-cli ping --json
gxshell-cli list --json
```

If access fails, `gxshell-cli doctor --json` diagnoses the executable, token and
daemon state. Do not print or copy the token. If the app is closed or the alias
is absent from `list`, explain the missing prerequisite; do not guess a hostname
or create another SSH route to bypass the app's access controls.

Verify an unfamiliar target with a small identity check before changing it:

```sh
gxshell-cli exec prod-web "uname -n" --json
gxshell-cli exec prod-web "cat /etc/os-release" --json
```

Keep the alias attached to each command, result and remote fact. Check the
returned `alias` before reporting an operation's result. When sources disagree
or a tool appears missing, verify the same alias and exec environment instead of
combining unrelated local, pasted or remote output.

## Choose transport and interpret results

- Use `exec` for one ordinary command without a literal newline or heredoc.
- Use `exec-file` or `exec-stdin` with an explicit `--shell` for multiline
  scripts, heredocs or difficult nested quoting.
- Request `--json` for automation. Read `outcome` alongside `alias`, `exitCode`,
  `stdout`, `stderr` and any truncation or remote-state fields.

```sh
gxshell-cli exec prod-web "systemctl is-active nginx" --json
gxshell-cli exec-file prod-web ./check.sh --shell bash --json
```

PowerShell can send a multiline script without embedding it in argv:

```powershell
Get-Content ./check.sh -Raw | ./gxshell-cli.exe exec-stdin prod-web --shell bash --json
```

`succeeded` means the remote program exited successfully; `remote_failed` means
gxShell allowed it but the program failed. `blocked` identifies an app/user
policy stop. `validation_error` and `client_error` need a request or setup fix.
`timeout` does not prove that remote work stopped. Inspect remote state before
retrying or claiming that nothing changed. Truncated output is incomplete evidence.

Retain `requestId` for deliberate retries of the same request. Reuse it only
with the same target, input and options, within the same app process and the
contract's retention window. Do not automatically replay an uncertain operation
after a restart, timeout or expired request record.

## Respect authorization and protect credentials

Current CLI approvals use risk tiers T0–T3, scoped trust and a separate **Full
trust for 1 hour** option. Inspect `riskTier`, `approval`, `blockedBy`, `reason`
and `detail`; do not infer approval behavior from an old command-name whitelist.
Existing trust does not expand the user's task or authorize enabling broader
trust. A pending native approval can explain a pause; do not submit duplicates.

Scripts, interpreters, build hooks and uploaded programs are arbitrary code, not
a stronger approval mode or sandbox. The user's authorization must cover their
actual source, targets and effects. Do not disguise a rejected operation through
another interpreter, encoding or transfer-and-execute sequence.

Use existing `secret://name` references. Bind a name through `--secret`, then use
the environment variable remotely rather than the reference as a literal password:

```sh
gxshell-cli exec prod-web 'curl -H "Authorization: Bearer $API_KEY" https://example.test/v1/models' --secret API_KEY=service-key --json
```

Keep the value in gxShell's credential vault. Let gxShell resolve the reference
and inject it through SSH stdin; do not put the value in argv, generated source,
logs or the model's context. Secret-bearing execution is synchronous: do not use
`--follow` or `--detach`. If the user needs to add a value, prefer the masked
credential-vault UI or the stdin workflow in the agent contract. Do not print a
secret just to test it, reconstruct redacted output, or treat output protection
as containment against arbitrary secret transformations.

## Files, jobs and temporary resources

Use dedicated single-file SFTP operations for local transfers:

```sh
gxshell-cli transfer push ./config.yaml prod-web:/srv/app/config.yaml --json
gxshell-cli transfer pull prod-web:/var/log/app.log ./app.log --json
gxshell-cli copy prod-web:/tmp/config.tar dev-box:/tmp/config.tar --json
```

Local transfers always require native approval. Request `--overwrite` only when
replacing the destination is authorized; upload-only `--mkdir` creates missing
parent directories. Upload permission covers moving the file, not executing it.
Remote-to-remote copy has its own endpoint trust and sensitive-path rules.

For long work, choose an appropriate `--timeout` (up to 30 minutes) or a
background job if the task warrants it. Read job outcomes and remote-state
information; cancellation acknowledges a request, not confirmed remote termination.
Read the CLI reference before using `--follow`, `--detach` or job commands.

For a temporary tunnel, retain its returned ID and close that tunnel when the
workflow finishes or fails, then verify the result with `tunnel list --json`.
Use loopback bindings; do not leave a tunnel open by accident or close tunnels
belonging to unrelated work.
