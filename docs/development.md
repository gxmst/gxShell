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
