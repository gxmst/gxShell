# Releasing

Releases are tag-driven. The `v*` workflow validates the version, runs the
full Windows verification suite, builds the desktop app and CLI, and publishes
exactly two assets:

```text
gxShell-v<version>-windows-amd64.zip
SHA256SUMS.txt
```

The zip keeps `gxShell.exe`, `LICENSE`, and `BUILD-MANIFEST.txt` at its root.
The optional CLI is grouped under `CLI/` with `gxshell-cli.exe`,
`CLI-README.md`, `CLI-README.zh-CN.md`, and `agent-guide.md`. This keeps the
desktop entry point unambiguous while making the CLI, its Chinese quick-start,
and its automation safety contract discoverable together. The release body is
extracted from the matching section in the root `CHANGELOG.md`; there is no
separate release-notes source.

## Local preparation

1. Update `backend/version/version.go`, `wails.json`, and `frontend/package.json` to the same version.
2. Add the release section to `CHANGELOG.md` using `## [x.y.z] - YYYY-MM-DD`.
3. Run the checks in [development.md](development.md).
4. Review the staged file names and make sure local staging directories, credentials, and build caches are excluded.
5. Push the commit and tag, for example:

```powershell
git push origin main
git tag v1.5.1
git push origin v1.5.1
```

The GitHub workflow then creates the Release and uploads the package. Do not
upload raw build directories, PDB files, frontend `dist`, local databases, or
user configuration.

## Supported release target

Windows x64 is the supported downloadable target. Linux and macOS desktop jobs
remain compile-only CI artifacts until they receive runtime testing.
