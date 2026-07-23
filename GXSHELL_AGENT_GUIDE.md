# gxShell Agent Guide

This is the shared contract for Claude Code, Codex, DeepSeek, and other automation clients that use `gxshell-cli`. Correctness does not depend on a model-specific file: the CLI also enforces the important input rules and returns structured outcomes.

## Choose the correct execution mode

Use `exec` only for one ordinary shell command with no literal newline or heredoc:

```powershell
.\gxshell-cli.exe exec 3 "uname -a" --json
```

Use `exec-stdin` or `exec-file` for every multiline script, heredoc, generated program, or command with difficult nested quoting:

```powershell
Get-Content .\check.sh -Raw | .\gxshell-cli.exe exec-stdin 3 --shell bash --json
.\gxshell-cli.exe exec-file 3 .\check.sh --shell bash --json
```

Do not embed a heredoc in the `exec` argument. The CLI rejects it with `errorKind: script_input_required` and recommends the stdin form. This avoids parsing the same text through the caller shell, Windows argument handling, JSON, and the remote shell.

## Interpret fields instead of guessing

Always request and inspect JSON. `outcome` is authoritative:

- `succeeded`: the remote command exited successfully.
- `remote_failed`: the remote program or shell returned a non-zero exit code. gxShell did not block it. Inspect `exitCode`, `stdout`, and `stderr`.
- `blocked`: gxShell policy or the user stopped the operation. Inspect `blockedBy`, `reason`, and `detail`.
- `timeout`: the SSH exec channel timed out; the remote system may have made partial changes.
- `validation_error` or `client_error`: fix the request before reasoning about the server.

Never describe a plain non-zero `exitCode` as a gxShell guard rejection. A guard rejection is explicitly marked `blocked: true` and `outcome: blocked`.

## Use named secrets without revealing values

Store a secret by piping it over stdin. Never put the value in argv, source code, a prompt, or a command string:

```powershell
Get-Content .\api-key.txt -Raw | .\gxshell-cli.exe secret set anyrouter-api-key
.\gxshell-cli.exe secret status anyrouter-api-key --json
```

The model should use only `secret://anyrouter-api-key`. Bind it to an environment variable at execution time:

```powershell
.\gxshell-cli.exe exec 3 'curl -H "Authorization: Bearer $API_KEY" https://example.test/v1/models' --secret API_KEY=anyrouter-api-key --json
```

For a script:

```powershell
Get-Content .\request.sh -Raw | .\gxshell-cli.exe exec-stdin 3 --shell bash --secret API_KEY=anyrouter-api-key --json
```

gxShell resolves the reference only after local approval, injects the value through SSH stdin, hides it from approval text and command audit, and replaces exact occurrences in captured output. Named-secret execution is synchronous only; `--follow` and `--detach` are rejected.

This protects against accidental disclosure, including `echo $API_KEY` and ordinary error output. It cannot make a general shell safe against a malicious command that transforms or encodes a secret before exfiltration. Approve secret-bearing commands only when their destination and purpose are clear. If a task only needs to test whether a secret works, do that without printing it.

Delete a reference when it is no longer needed:

```powershell
.\gxshell-cli.exe secret delete anyrouter-api-key
```

If a real key ever appears in a model conversation, process argument, terminal capture, or log, rotate it. Redaction does not revoke an exposed credential.
