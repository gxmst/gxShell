# Development

## Prerequisites

- Go 1.26.11+ (pinned by the `go` directive in `go.mod`; a newer toolchain is downloaded automatically)
- Node.js 20.19+ (or 22.13+) and npm
- Wails CLI v3.1.0 (install with `go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0`)
- Microsoft WebView2 Runtime for desktop execution

## Common checks

From the repository root:

```powershell
.\scripts\check-go.ps1 -Race
go build ./backend/... ./cmd/...
```

For the frontend:

```powershell
cd frontend
npm ci
npm audit --audit-level=moderate
npm run lint
npm test
npm run build
cd ..
```

Build the Windows desktop app with:

```powershell
.\scripts\build.ps1 -Clean
```

For live frontend reload on Windows, run `wails3 dev` from the repository root.
The development executable is `build/bin/gxShell-dev.exe`. The production script
builds the desktop application and CLI using the maintained bindings.
It leaves the desktop executable in `build/bin/gxShell.exe`, the embedded
frontend bundle in `frontend/dist`, and the CLI in `gxshell-cli.exe`. These are
ordinary build outputs. Use `scripts/build-archive.ps1` only when preparing an
archived delivery; it calls the same build script before copying final files.

The Go check script covers the root, backend, CLI and internal packages explicitly
so installed npm packages containing Go sources are excluded from our checks.

Build only the separate CLI with:

```powershell
go build -o gxshell-cli.exe .\cmd\gxshell-cli
```

## Dependency maintenance

Routine dependency upgrades are reviewed manually when needed for a bug fix,
security issue, or planned release. Dependabot version-update PRs are disabled
to avoid a recurring upgrade queue. CI continues to run `npm audit` and
`govulncheck` in the verification and release workflows.

## README media

The README screenshots use the actual English frontend with fictional data.
With Playwright and Sharp available on `NODE_PATH`, an installed Edge browser,
and FFmpeg on `PATH`, run from `frontend/`:

```sh
npm run marketing:capture
npm run marketing:readme
```

The capture writes images, a silent MP4, and subtitles to `docs/marketing/assets/`;
the second command writes compressed WebP images and a short GIF to its `readme/`
subdirectory. The native app and personal application data are not used.
Only reviewed media should be committed; ZIP packages, extracted media kits,
capture reports, and posting drafts are local working material.
GitHub strips ordinary HTML video tags from README content, so the README uses
an animated preview linked to the full MP4.

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
|-- Taskfile.yml               # Wails 3 build and development tasks
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

**Keep the frontend bridge in sync with the Go service.** The maintained
functions in `frontend/wailsjs/go/app` use Wails 3 `Call.ByName`. Keep their
JS and TypeScript declarations in sync with exported methods and keep the
handwritten model corrections. `npm run check:bindings` checks that surface.

## Further reading

- [CLI implementation notes](development/cli-implementation.md)
- [Session log retention](development/session-log-retention.md)
- [Document navigation and sidebar geometry](development/document-workspace.md)
- [Windows context menu integration](development/windows-context-menu.md)
- [Original project brief](history/todo-genesis-prompt.md) (historical)
