# CLI Implementation Notes

The CLI integration is implemented as a local authenticated proxy:

- `app_cli.go` starts a localhost HTTP server inside the GUI process.
- `cmd/gxshell-cli/main.go` is a small client that reads the local token and calls the GUI.
- `types.Profile` includes `cliEnabled` and `cliAlias` so access is explicit per profile. (Older profiles written under the `aiEnabled`/`aiAlias` keys are migrated to these on startup.)
- A global `AppSettings.cliServerEnabled` flag gates whether the localhost server starts at all; when false the listener is never opened. It defaults to false. A versioned, one-time consent migration also disables the server for settings written before this safer default, after which explicit user opt-ins are preserved.
- The server reuses an existing connected SSH session for the selected profile when possible and reports `reusedConnection` in structured exec responses.
- If no session exists, it connects through `App.Connect`, preserving the existing gxShell connection path.

Important safety choices:

- The whole server and every profile are disabled for CLI access by default. Users must first enable the global server and then opt in individual profiles.
- Each opted-in profile may receive time-limited automation trust (1/4/8/24 hours); there is no permanent trust switch. Trust auto-approves only T1 scoped, recoverable commands. T2 remains a native click. T3 is an immediate individual native click and is never batched, regardless of trust. Remote-to-remote copy retains its separate rule that both endpoint profiles must be trusted.
- `/cli/list` and `/cli/status` omit host, user, port, and profile ID.
- `/cli/exec`, `/cli/jobs`, `/cli/copy`, and `/cli/tunnels` require token authentication. External CLI exec runs through the pure classifier in `app_cmdtier.go`/`app_cmdtier_paths.go`; unresolvable or opaque behavior is at least T2. T1/T2 clicks may batch by alias within about one second, while T3 always uses its own native dialog. Every prompted command includes short action lines derived from classifier findings. The in-app risk card mirrors those lines and token spans but has no authorization controls.
- The legacy guard in `app_cmdguard.go` remains in use for built-in AI preflight and sensitive-path checks in transfer/copy code. It is not the external CLI exec authorization path. Neither policy is a sandbox.
- Exec defaults to a 2-minute remote command timeout. Timed-out commands return exit code 124 in the CLI, `errorKind: "remote"`, and a `timeoutHint` telling callers to inspect remote state before retrying because partial effects may already exist.
- Exec responses and job snapshots include `riskTier`, `riskLabel`, `riskCategories`, `approval`, and `approvalStrength` alongside execution fields such as `alias`, `reusedConnection`, `exitCode`, `stdout`, `stderr`, `durationMs`, `timedOut`, and `truncated`. Failures include `errorKind` where possible.
- `exec-file` and `exec-stdin` require an allowlisted `--shell`; the daemon starts `<shell> -s` and writes the normalized body through SSH stdin instead of embedding it in a command string.
- `--follow` and `--detach` use an in-memory job registry. Output callbacks append ordered stdout/stderr events, cancellation closes the exec channel, and finished jobs are retained for 30 minutes.
- Cross-server `copy` uses both cached SFTP clients, a sibling destination temp file, a second-pass SHA-256 verification, and atomic replacement. Directories are intentionally not supported by the first CLI version.
- `transfer push`/`pull` (with `upload`/`download` aliases) moves one local regular file through the GUI-owned SFTP manager and always uses native approval. Push approval includes size, SHA-256, script detection, and a 2 KiB UTF-8 preview; the uploader re-hashes the actual stream before atomic promotion. Successful uploads are remembered in process so a later exec naming that path is at least T2 and can repeat the approved hash/preview. The provenance cache is context, not remote integrity proof. Overwrite conflicts use the typed `sftpmanager.OverwriteRequiredError` and return `errorKind: "overwrite_required"` with CLI exit code 2.
- Temporary CLI local/SOCKS tunnels reuse `backend/tunnel`, always require native approval, reject non-loopback binds, are not persisted to profiles, and close on explicit removal, SSH disconnect, or application shutdown. Named-secret creation/deletion also always requires approval.
- `gxshell-cli` supports `--json`, `--timeout`, `--shell`, `--follow`, `--detach`, `exec-file`, `exec-stdin`, `job`, `copy`, `transfer`, `tunnel`, and `doctor`. The localhost request body limit is about 2 MB.
- `gxshell-cli doctor` reports the executable path, working directory, config/token path, PATH visibility, and local daemon reachability to reduce setup confusion when the binary is invoked from different shells or folders.
- The CLI command-line binary is separate from the Wails desktop binary and is built with `go build -o gxshell-cli.exe .\cmd\gxshell-cli`.

Run verification with:

```powershell
go test ./...
cd frontend
npm run build
```
