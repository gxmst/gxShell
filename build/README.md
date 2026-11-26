# Desktop build assets

The Windows build uses `windows/icon.ico`, `windows/wails.exe.manifest` and
`windows/info.json` to generate the architecture-specific Go resource object.
The Wails 3 tray uses `windows/icon.png`. The experimental macOS bundle uses
`darwin/Info.plist`. `config.yml` configures the Wails development watcher.

Run `scripts/build.ps1` for the Windows executable and CLI. The output paths
and prerequisites are documented in [Development](../docs/development.md).
