# Encrypted backup and migration

Implemented on 2026-09-10. Open **Settings → Data** and choose **Export encrypted
backup** or **Import encrypted backup**. Save pending settings edits first.

The `.gxbak` file contains saved server profiles, command templates, global
settings, highlight rules, named workspaces (including independent terminal
instances and split layouts), and trusted SSH host keys. Saved passwords, key
passphrases, AI/named API credentials, and private key files are separate export
options. Both options default to off. Including either requires native
confirmation. Credentials are decrypted only in the native process and are
never included in the preview or plaintext profile JSON.

External documents, remote files, logs, recordings, shell history and live
terminal processes are outside this configuration backup. Workspace file paths
remain visible, with a warning if a file is missing or needs authorization.
Private keys included in the backup are written under a new `imported-keys`
directory inside the destination application data directory; excluded keys must
be selected again. Local shell paths remain those of the destination computer.

Import first validates and previews the contents. **Keep existing items** skips
conflicting profiles, commands and workspaces; **Import as copies** gives them
new identities. Profile and jump-host references, workspace focus and split
references are remapped together. If keeping a profile maps two workspace panes
to the same server, the second pane gets an independent terminal instance.
Existing host fingerprints and named credentials win conflicts. Special host-key
rules that cannot safely be merged are listed for manual review.

Global settings can be restored separately. Existing CLI-server and update-check
opt-ins stay local; CLI automation trust and local file grants are not migrated.
Restoring AI settings without an included API key clears the prior AI credential
and reports that it must be entered again. Restoring a backup does not open
connections or run login commands.

The file uses a versioned JSON envelope, PBKDF2-HMAC-SHA256 (210,000 iterations,
random 16-byte salt) and AES-256-GCM (random nonce and authenticated format).
Passphrases need at least eight Unicode characters. Encrypted files are limited
to 50 MiB and plaintext payloads to 30 MiB. Profile/command/settings files retain
the application's 10 MiB limit; private keys are limited to 1 MiB each.

Preview tokens are single use and expire after 15 minutes. Changed configuration,
host keys, workspaces or affected credentials invalidate a preview. Browser
storage is checked and reserved before native writes. Native files are staged;
failed file or credential writes restore previous values, and the browser then
restores its exact previous workspace value. A failed rollback is reported rather
than being treated as success. The close gate prevents normal window closing
during import. This handles operation failures, not power loss or forced process
termination across the native files, OS credential manager and browser storage.

Validation for this batch:

- `go test ./...` and `go vet ./...` passed, including encryption/tamper checks,
  real SSH instance tests, conflict/reference validation, private-key relocation,
  credential redaction, stale previews, file/cache rollback and credential-store
  rollback. Credential tests use isolated stores and an in-memory native adapter.
- Frontend: 325 tests in 50 files passed. Lint has zero errors and 52 existing
  warnings. Storage quota failures prevent native writes; native failure restores
  workspaces. Modal tests cover masked input, opt-in export and explicit apply.
- `wails build -skipbindings -o gxShell-before-compat.exe` passed with Go 1.26.8
  on Windows amd64. The ordinary comparison binary is
  `build/bin/gxShell-before-compat.exe` (20,919,296 bytes); `frontend/dist` is the
  embedded frontend bundle. No installer or external build archive is created.
- `frontend/scripts/smoke-workbench.mjs` covers backup dialogs and the import
  close gate alongside the existing workbench checks at 1440×960, 900×700 and
  540×720. Run it from `frontend` with Playwright and sharp on Node's module path.
  Its mocked backend does not access saved credentials or real servers.

Native file-dialog interactions, real Windows credential-manager migration,
physical IME and sleep/resume still require platform acceptance testing. The
local machine has no C compiler for `go test -race`; CI retains that check.
