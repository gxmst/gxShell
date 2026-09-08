# Terminal Workbench Batches

Scope: the three priority groups agreed on 2026-09-08.

- [x] Batch 1: focus ownership during restoration and slow connections;
  reconnect lifecycle and network recovery; IME shortcut handling; sustained IO checks.
  Verified: 54 frontend regression tests, production frontend build, Go SSH and
  terminal IO tests including 20 concurrent Unicode streams. The local race
  detector requires a C compiler which is not on PATH.
- [x] Batch 2: user highlight rules; per-profile terminal preferences;
  automatic, bounded session output logs with rotation and a log browser.
  Verified: custom RE2 rules (including adversarial repetition and Unicode
  offsets), streaming ANSI/Unicode log parsing, concurrent streams, daily/size
  rotation, retention at the connection limit, frontend production build and
  Go config/SSH/app tests.
- [x] Batch 3: bulk profile editing; named workspaces; four terminal panes.
  Verified: atomic profile updates preserve credentials and trust; workspace
  restoration preserves open documents and later focus requests, and restores
  saved server titles, pins and layout; four-pane output and input routing.

Final checks on 2026-09-08:

- Frontend: 306 tests in 47 files passed; lint has 0 errors and 52 warnings.
- Backend: `go test ./...` and `go vet ./...` passed.
- Security: govulncheck v1.7.0 reports 0 reachable vulnerabilities and 1
  module-level finding outside the code's call paths.
- Windows production build: `wails build -skipbindings` passed, including the
  frontend i18n, version, binding, CSS and TypeScript gates.
- Standalone CLI: `go build -o gxshell-cli.exe ./cmd/gxshell-cli` passed.
- Browser checks: 1440x960, 900x700 and 540x720, with four nonblank terminal
  panes, per-pane input, document focus, sidebar width, workspace and bulk-edit
  dialogs, and highlighting controls. Header buttons remain horizontal; narrow
  containers wrap whole controls instead of splitting their text.

Review corrections included in the final change:

- Automatic reconnects that fail after the network drops return to an error
  state, allowing the online handler to retry them.
- Workspace restoration resolves a replacement session by its stable profile
  identity, so a slow authentication on another server cannot lose the saved
  layout or focus.
- Session log lines completed in a later output chunk use that chunk's
  timestamp, including when the chunk crosses midnight.

The repeatable browser check is `frontend/scripts/smoke-workbench.mjs`. It
expects Playwright and sharp on Node's module search path, plus Microsoft Edge
(or another installed channel selected with `PLAYWRIGHT_CHANNEL`). It starts
and closes an isolated local Vite server and mocked Wails runtime; screenshots
use a unique temporary directory. It never uses saved credentials or live SSH
servers.

Ordinary build outputs: `build/bin/gxShell.exe` is the Windows application,
`gxshell-cli.exe` is the separate CLI, and `frontend/dist` is the embedded web
bundle. No installer or external archive is produced by these commands.

Each batch includes regression checks. Physical IME, VPN and sleep/resume were
not exercised; the browser uses simulated sessions. Local `go test -race` was
not run because a C compiler is unavailable.

Native multi-window support and the optional protocol, network appliance,
file synchronization and commercial distribution extensions remain separate work.
