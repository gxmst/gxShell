# CLI Implementation Notes

The CLI integration is implemented as a local authenticated proxy:

- `app_cli.go` starts a localhost HTTP server inside the GUI process.
- `cmd/gxshell-cli/main.go` is a small client that reads the local token and calls the GUI.
- `types.Profile` includes `aiEnabled` and `aiAlias` so access is explicit per profile.
- The server reuses an existing connected SSH session for the selected profile when possible.
- If no session exists, it connects through `App.Connect`, preserving the existing gxShell connection path.

Important safety choices:

- No profile is exposed by default.
- `/cli/list` and `/cli/status` omit host, user, port, and profile ID.
- `/cli/exec` requires token authentication. Simple read-only allowlisted commands run without a prompt; commands with shell operators, quoting, variable/tilde expansion, globs, or anything outside the allowlist require native user confirmation each time.
- Existing dangerous-command and sensitive-path checks still run before execution.
- The CLI command-line binary is separate from the Wails desktop binary and is built with `go build -o gxshell-cli.exe .\cmd\gxshell-cli`.

Run verification with:

```powershell
go test ./...
cd frontend
npm run build
```
