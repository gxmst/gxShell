# CLI Implementation Notes

The CLI integration is implemented as a local authenticated proxy:

- `app_cli.go` starts a localhost HTTP server inside the GUI process.
- `cmd/gxshell-cli/main.go` is a small client that reads the local token and calls the GUI.
- `types.Profile` includes `cliEnabled` and `cliAlias` so access is explicit per profile. (Older profiles written under the `aiEnabled`/`aiAlias` keys are migrated to these on startup.)
- A global `AppSettings.cliServerEnabled` flag gates whether the localhost server starts at all; when false the listener is never opened. Missing values in older `settings.json` files are backfilled to true on startup to preserve prior behavior.
- The server reuses an existing connected SSH session for the selected profile when possible and reports `reusedConnection` in structured exec responses.
- If no session exists, it connects through `App.Connect`, preserving the existing gxShell connection path.

Important safety choices:

- No profile is exposed by default, and the whole server can be turned off via `Enable CLI server` in Settings.
- Each opted-in profile may receive time-limited full trust (1/4/8/24 hours). While its wall-clock deadline is active, command execution skips interactive approval; there is no permanent trust switch. It does not bypass command preflight blocks for catastrophic operations or sensitive credential paths.
- `/cli/list` and `/cli/status` omit host, user, port, and profile ID.
- `/cli/exec`, `/cli/jobs`, `/cli/copy`, and `/cli/tunnels` require token authentication. Simple read-only allowlisted commands run without a prompt; by default, commands with shell operators, quoting, variable/tilde expansion, globs, or anything outside the allowlist require native user confirmation. Requests for the same alias that arrive within about one second are batched into one prompt. Active per-profile trust bypasses this confirmation tier only. A cross-server copy bypasses approval only when both endpoint profiles are trusted.
- Existing dangerous-command and sensitive-path checks still run before execution. Blocked responses include `blockedBy`, `reason`, and `detail` so callers can tell which policy category and command/path fragment triggered the block.
- Exec defaults to a 2-minute remote command timeout. Timed-out commands return exit code 124 in the CLI, `errorKind: "remote"`, and a `timeoutHint` telling callers to inspect remote state before retrying because partial effects may already exist.
- Exec responses include `alias`, `reusedConnection`, `exitCode`, `stdout`, `stderr`, clean remote `output`, synthetic `summary`, human `displayOutput`, `durationMs`, `timeoutMs`, `timedOut`, and `truncated`. Failures include `errorKind` where possible.
- `exec-file` and `exec-stdin` require an allowlisted `--shell`; the daemon starts `<shell> -s` and writes the normalized body through SSH stdin instead of embedding it in a command string.
- `--follow` and `--detach` use an in-memory job registry. Output callbacks append ordered stdout/stderr events, cancellation closes the exec channel, and finished jobs are retained for 30 minutes.
- Cross-server `copy` uses both cached SFTP clients, a sibling destination temp file, a second-pass SHA-256 verification, and atomic replacement. Directories are intentionally not supported by the first CLI version.
- Temporary CLI local/SOCKS tunnels reuse `backend/tunnel`, always require native approval, reject non-loopback binds, are not persisted to profiles, and close on explicit removal, SSH disconnect, or application shutdown. Named-secret creation/deletion also always requires approval.
- `gxshell-cli` supports `--json`, `--timeout`, `--shell`, `--follow`, `--detach`, `exec-file`, `exec-stdin`, `job`, `copy`, `tunnel`, and `doctor`. The localhost request body limit is about 2 MB.
- `gxshell-cli doctor` reports the executable path, working directory, config/token path, PATH visibility, and local daemon reachability to reduce setup confusion when the binary is invoked from different shells or folders.
- The CLI command-line binary is separate from the Wails desktop binary and is built with `go build -o gxshell-cli.exe .\cmd\gxshell-cli`.

Run verification with:

```powershell
go test ./...
cd frontend
npm run build
```
