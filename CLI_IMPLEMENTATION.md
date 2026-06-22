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
- `/cli/list` and `/cli/status` omit host, user, port, and profile ID.
- `/cli/exec` requires token authentication. Simple read-only allowlisted commands run without a prompt; commands with shell operators, quoting, variable/tilde expansion, globs, or anything outside the allowlist require native user confirmation. Requests for the same alias that arrive within about one second are batched into one prompt.
- Existing dangerous-command and sensitive-path checks still run before execution.
- Exec responses include `alias`, `reusedConnection`, `exitCode`, `stdout`, `stderr`, clean remote `output`, synthetic `summary`, human `displayOutput`, `durationMs`, `timedOut`, and `truncated`. Failures include `errorKind` where possible.
- `gxshell-cli` supports `--json`, `--timeout`, `exec-file`, and `exec-stdin`; script bodies are normalized (leading UTF-8 BOM stripped, CRLF/CR converted to LF) and sent as JSON request content to avoid PowerShell argument quoting and here-doc line-ending problems. The localhost request body limit is about 2 MB.
- The CLI command-line binary is separate from the Wails desktop binary and is built with `go build -o gxshell-cli.exe .\cmd\gxshell-cli`.

Run verification with:

```powershell
go test ./...
cd frontend
npm run build
```
