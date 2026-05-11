# gxShell

gxShell is a Wails + Go + React desktop SSH workbench for Windows-first server management.

## Current 1.0 Features

- Wails desktop shell, no Electron and no Tauri
- Go SSH backend with interactive PTY shell sessions
- xterm.js terminal rendering with fit and search addons
- Multi-tab SSH sessions
- Password and private-key profile support
- JSON config storage under the system user config directory
- Password and private-key passphrase storage via the system credential store
- `known_hosts` host-key tracking with trust-on-first-use and changed-key rejection
- Server profile CRUD, duplicate, favorite and recent connection metadata
- SFTP remote browser with upload, download, delete, rename and mkdir
- Linux server monitor using background SSH exec sessions, not the user terminal
- Command palette with editable command templates
- Terminal themes, font, monitor interval and settings UI
- Wails event bridge for terminal data, session state, SFTP progress and metrics
- Local app log file without intentional secret logging

## Development

Required tools:

- Go
- Node.js + npm
- Wails CLI
- Microsoft WebView2 Runtime

Useful commands:

```powershell
wails doctor
go test ./...
cd frontend
npm install
npm run build
cd ..
wails build -clean
```

The compiled Windows executable is written to:

```text
build/bin/gxShell.exe
```

## Notes

Profiles are stored in JSON, but passwords and private-key passphrases are not written to JSON. When "Save password or passphrase" is enabled, gxShell stores secrets through the operating system credential store. Existing plaintext secrets from older local builds are migrated out of JSON on startup when possible.

SSH host keys are tracked in the app data directory's `known_hosts` file. First-time hosts are trusted on first use; changed host keys are rejected.

Linux monitoring is the first supported target. Non-Linux hosts still work for SSH and SFTP, but some monitor values may be blank.
