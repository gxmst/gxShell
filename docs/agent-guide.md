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

## Treat Scripts And Interpreters As Arbitrary Code

`exec-file` and `exec-stdin` are transport modes, not sandboxes. The same is
true of a command that starts an interpreter, build tool, or compiler. gxShell
classifies visible command and script text into risk tiers, but it cannot prove
what an arbitrary Python, Node, Perl, Ruby, `awk`, compiled program, or decoded
payload will do after it starts.

An agent must not use another program to disguise an operation that would need
a higher-risk approval or that the user did not authorize. This includes:

- generating or uploading a script and then executing it;
- using an interpreter's `-c`/`-e` option or a shell wrapper;
- decoding, decompressing, compiling, or fetching code before running it;
- replacing a blocked command with equivalent library calls or system APIs.

Treat the complete script or generated program, its destination, file changes,
network destinations, and secret use as the requested action. A successful
upload approval covers file movement only; it does not approve executing the
uploaded file. A profile trust window suppresses approval only for T1 scoped,
recoverable changes; opaque execution is at least T2 and still prompts. This is
a policy control for cooperative automation, not containment against a
malicious token holder or cleverly disguised program. Use arbitrary scripts
only when the user has explicitly authorized that exact source and purpose.
Prefer a small, inspectable command or a dedicated CLI operation when one
exists.

`blocked: false` means only that gxShell did not stop the request. It does not
mean that the operation is read-only, harmless, or fully reviewed.

## Interpret fields instead of guessing

Always request and inspect JSON. `outcome` is authoritative:

- `succeeded`: the remote command exited successfully.
- `remote_failed`: the remote program or shell returned a non-zero exit code. gxShell did not block it. Inspect `exitCode`, `stdout`, and `stderr`.
- `blocked`: gxShell policy or the user stopped the operation. Inspect `blockedBy`, `reason`, and `detail`.
- `timeout`: the SSH exec channel timed out; the remote system may have made partial changes.
- `validation_error` or `client_error`: fix the request before reasoning about the server.

Never describe a plain non-zero `exitCode` as a gxShell guard rejection. A guard rejection is explicitly marked `blocked: true` and `outcome: blocked`.

For `exec`, also inspect `riskTier`, `riskCategories`, `approval`, and
`approvalStrength`. The approval policy is:

- T0 observation: no prompt.
- T1 scoped, recoverable change: no prompt only during an active trust window;
  otherwise one native click.
- T2 bounded destructive, opaque, or external action: one native click even
  during a trust window.
- T3 irreversible, self-locking, credential, or public action: immediate native
  click and never part of an "Allow all" batch, regardless of trust.

Prompted commands include a short classifier-derived explanation of recognized
behavior and targets below the command. Treat it as a review aid, not a safety
proof; opaque behavior remains at least T2.

The native dialog is the authorization boundary. Any coloured in-app risk card
is explanatory only and never grants permission.

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

gxShell resolves the reference only after the applicable local approval gate,
injects the value through SSH stdin, hides it from approval text and command
audit, and replaces exact occurrences in captured output. Named-secret
execution is synchronous only; `--follow` and `--detach` are rejected. A trust
window does not bypass T3 credential confirmation, and exact-value redaction is
still not a secret sandbox: transformed or encoded values may evade it.

This protects against accidental disclosure, including `echo $API_KEY` and ordinary error output. It cannot make a general shell safe against a malicious command that transforms or encodes a secret before exfiltration. Approve secret-bearing commands only when their destination and purpose are clear. If a task only needs to test whether a secret works, do that without printing it.

Delete a reference when it is no longer needed:

```powershell
.\gxshell-cli.exe secret delete anyrouter-api-key
```

If a real key ever appears in a model conversation, process argument, terminal capture, or log, rotate it. Redaction does not revoke an exposed credential.

## Transfer local files

Use the dedicated transfer command when a local artifact must move to or from a CLI-enabled server. It supports one regular file at a time and does not interpret directories or globs:

```powershell
.\gxshell-cli.exe transfer push .\build\app.tar.gz prod-web:/srv/app/app.tar.gz --mkdir --json
.\gxshell-cli.exe transfer pull prod-web:/srv/app/app.tar.gz .\downloads\app.tar.gz --json
```

`upload` and `download` are aliases for `transfer push` and `transfer pull`. The GUI always shows a native approval dialog for these operations; an active CLI trust window never suppresses it. Existing destinations are protected by default. Add `--overwrite` only after checking that replacing the destination is intended. A conflict is authoritative when the JSON contains `outcome: "blocked"`, `blockedBy: "overwrite-policy"`, and `errorKind: "overwrite_required"`; the CLI exits with code 2. Upload-only `--mkdir` creates missing remote parent directories. Transfers use gxShell's atomic SFTP promotion and resumable partial files; do not construct an `scp` or shell command to emulate them.
