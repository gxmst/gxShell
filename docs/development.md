# Development

## Prerequisites

- Go 1.24+
- Node.js 20.19+ (or 22.13+) and npm
- Wails CLI v2
- Microsoft WebView2 Runtime for desktop execution

## Common checks

From the repository root:

```powershell
go test ./...
go vet ./...
go build ./backend/... ./cmd/...
```

For the frontend:

```powershell
cd frontend
npm ci
npm run lint
npm test
npm run build
cd ..
```

Build the Windows desktop app with:

```powershell
wails build -clean
```

Build the separate CLI with:

```powershell
go build -o gxshell-cli.exe .\cmd\gxshell-cli
```

## Project layout

```text
gxShell/
|-- main.go                    # Root Wails entry point and embedded assets
|-- internal/app/              # Desktop app implementation and tests
|-- cmd/gxshell-cli/           # Separate CLI binary
|-- backend/                   # SSH, SFTP, config, secrets, and remote managers
|-- frontend/                  # React UI and hand-maintained Wails bindings
|-- build/                     # Icons and Windows packaging metadata
|-- docs/                      # User, security, architecture, and release docs
|-- .github/                   # CI and release automation
|-- wails.json                 # Desktop build configuration
```

The root `main.go` intentionally stays at the repository root because it
embeds `frontend/dist` and the Windows tray icon using `go:embed`. The app
implementation lives in `internal/app`; its Wails bindings are maintained in
`frontend/wailsjs/go/app/`.

## Two rules that are easy to break

**Do not add exported methods to `App` for `main.go`'s benefit.** Wails binds
every exported method of a bound struct as something the webview can call by
name, so an exported method is a frontend API whether or not that was the
intent. Lifecycle plumbing reaches `main.go` through the package-level seam in
`internal/app/entrypoint.go` for this reason: `handleSecondInstanceLaunch`
feeds `allowFile`, which is what authorizes a path for
`ReadLocalFile`/`WriteLocalFile`, so binding it would let a compromised
renderer read or overwrite any file with a supported text extension. Add new
frontend APIs deliberately, not as a side effect of package structure.

**`frontend/wailsjs/` is hand-maintained, not generated output.** CI builds
with `-skipbindings`. Running `wails generate module` reverts local fixes: it
regresses `Profile.cliTrustUntil` in `models.ts` from `string` back to `any`.
If you do run it, diff the result and keep the hand-written corrections. When
adding a backend method, hand-edit `App.d.ts`, `App.js`, and any new type in
`models.ts`.

## Further reading

- [CLI implementation notes](development/cli-implementation.md)
- [Windows context menu integration](development/windows-context-menu.md)
- [Original project brief](history/todo-genesis-prompt.md) (historical)
