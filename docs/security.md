# Security model

gxShell is designed to make remote operations explicit and to keep saved
credentials away from ordinary profile data and terminal input.

## Credentials and local data

- Saved SSH passwords, key passphrases, and AI API keys use the operating-system credential store when available.
- The fallback store uses AES-256-GCM and wraps its key with Windows DPAPI.
- Older plaintext profile secrets are migrated on startup and removed from normal profile JSON.
- Named secrets are resolved only at the execution boundary and exact values are redacted from captured output.

## AI and CLI controls

- CLI access is globally disabled by default and is additionally opt-in per profile.
- Requests stay on `127.0.0.1` and require a local bearer token.
- The CLI exposes aliases rather than hostnames, usernames, ports, profile IDs, or jump-host details.
- External CLI `exec` requests use behavior-based T0-T3 risk tiers. Inside a
  trust window, T1 scoped, recoverable changes and T2 bounded local operations
  run without a prompt. T2 operations the classifier cannot statically resolve,
  or whose effect leaves the machine, still require a native click, and T3 uses
  an immediate individual click and never joins a batch, regardless of trust.
  Prompted commands include a short classifier-derived explanation of their
  recognized behavior and target.
- The native dialog is authoritative. The in-app coloured risk card is
  informational and cannot approve execution.
- Transfer/copy sensitive-path policy can still block an operation outright.
  The built-in AI assistant retains its known-pattern command preflight and
  short-lived, single-use native authorizations. It does not yet share the
  external CLI's tier path.
- Local transfers, tunnels, and secret changes always require native
  confirmation. Remote copies may skip it only when both profiles are trusted.

## Terminal and files

- CLI commands use short-lived SSH exec channels rather than typing into the interactive PTY.
- Terminal highlighting and links are display-layer decorations; they do not rewrite SSH output or inject ANSI data.
- Local text-file access is limited to files the user selected through a native dialog, OS open action, drag-and-drop, or authorized siblings.
- Workspace restore accepts only paths recorded by the backend in the config directory's `document-access.dat`. Renderer storage alone cannot grant access. Missing or invalid history leaves documents unauthorized; documents opened before this record existed need to be selected or confirmed once again. The history contains paths, not document contents, and cannot be opened as an editable text sibling.
- SFTP resume binds partial files to a source identity, path, size, and modification time, then compares the full existing prefix before appending. A changed prefix restarts the transfer; legacy partials are not resumed. Verification reads the prefix again and adds network I/O. This does not provide a snapshot of a source that changes during the transfer.
- Remote editor saves write a sibling temporary file and promote it only after writing and closing succeed. Failure to create that temporary file or replace the destination is reported without falling back to truncating the original. Saving therefore requires the directory permissions needed for a temporary file and rename.
- Login commands are deliberately raw and appear in terminal history/scrollback; never put credentials in them.

## Network and privacy

- gxShell sends no telemetry.
- The optional update check is disabled by default. When enabled, it performs an unauthenticated read of the public GitHub release feed.
- CLI tunnels bind only to loopback and are temporary; close them after use.
- The CLI's HTTP listener address is hard-coded to `127.0.0.1:56789` and cannot
  be configured. There is no setting that exposes it on a routable interface —
  the only switch is on or off. A side effect worth naming since the project is
  AGPL-3.0: an unmodified gxShell has no remote network users, so section 13
  does not come into play in ordinary desktop use.

This model is a set of guardrails, not a sandbox. In particular, a shell script,
an uploaded program, an interpreter or build-tool invocation, or code that is
decoded or compiled on the server can perform actions that do not resemble its
outer command text. Risk classification helps a cooperative client and reviewer;
it is not containment against a malicious local token holder. A non-blocked
result is not a claim that the operation is safe.
Review the complete source, command, destination, and secret/network use before
approving or trusting automation. Rotate any credential that appears in a
prompt, process argument, terminal capture, or log.
