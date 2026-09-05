# Contributing

Thanks for considering a contribution to gxShell! Bug reports, feature
discussions, and pull requests are all welcome.

## Development setup

- Windows 10/11 x64 with the WebView2 Runtime is the supported desktop target;
  Linux/macOS builds are experimental CI artifacts.
- Go 1.26.8+ (see the `go` directive in `go.mod`), Node.js 20.19+ (CI pins 22), and the
  [Wails v2 CLI](https://wails.io) for desktop builds.

Read [docs/development.md](docs/development.md) first — it explains the build
flags (notably why `wails build -clean -skipbindings` is required) and the
project layout. [docs/architecture.md](docs/architecture.md) covers how the
backend modules and the React frontend fit together.

## Checks before you push

The frontend build chains the same gates CI uses, so a clean local run is a
good predictor of CI:

```bash
cd frontend
npm ci
npm run lint
npm test
npm run build   # runs check:i18n, check:version, check:bindings, check:css
```

```bash
go test -race ./...
go vet ./...
```

## House rules

- `frontend/wailsjs` bindings are hand-maintained. Never regenerate them;
  `check:bindings` asserts hand-applied corrections and will fail a
  regeneration.
- User-visible strings go through `frontend/src/i18n.ts` with zh/en parity;
  `check:i18n` enforces it. Avoid inline `lang === "zh-CN"` ternaries.
- `backend/version/version.go` is the single source of truth for the version.
  `wails.json` and `frontend/package.json` carry literals that
  `check:version` compares against it; bump all three together (plus a
  CHANGELOG entry).
- Commits follow conventional style with optional scopes, e.g.
  `fix(ui): …`, `feat(sftp): …`, `docs: …`, `chore: …`.
- Match the surrounding code: the codebase keeps manager state behind
  mutexes, prefers explicit teardown on every error path, and comments
  *why*, not *what*.

## Security-sensitive changes

If your change touches the approval/tier classifier, secret handling, the CLI
HTTP server, or host key verification, please also update
[docs/security.md](docs/security.md), [docs/cli.md](docs/cli.md), and
[docs/agent-guide.md](docs/agent-guide.md) in the same change so the
documented guarantees stay true. See [SECURITY.md](SECURITY.md) for private
vulnerability reporting.

## License

By contributing you agree that your work is released under the repository's
[AGPL-3.0](LICENSE) license.
