# Security model

gxShell is designed to make remote operations explicit and to keep saved
credentials away from ordinary profile data and terminal input.

## Credentials and local data

- Saved SSH passwords, key passphrases, and AI API keys use the operating-system credential store when available.
- The fallback store uses AES-256-GCM and wraps its key with Windows DPAPI.
- Older plaintext profile secrets are migrated on startup and removed from normal profile JSON.
- Named secrets are resolved only at the execution boundary and exact values are redacted from captured output.

## AI and CLI controls

- CLI access is disabled globally when its server setting is off and is opt-in per profile.
- Requests stay on `127.0.0.1` and require a local bearer token.
- The CLI exposes aliases rather than hostnames, usernames, ports, profile IDs, or jump-host details.
- Non-read-only commands, transfers, tunnels, and secret changes require native confirmation unless a limited trust window applies.
- Dangerous commands and sensitive remote paths are hard-blocked before execution.
- AI tools are short-lived, single-use authorizations and require native confirmation before remote execution or file reads.

## Terminal and files

- CLI commands use short-lived SSH exec channels rather than typing into the interactive PTY.
- Terminal highlighting and links are display-layer decorations; they do not rewrite SSH output or inject ANSI data.
- Local text-file access is limited to files the user selected through a native dialog, OS open action, drag-and-drop, or authorized siblings.
- Login commands are deliberately raw and appear in terminal history/scrollback; never put credentials in them.

## Network and privacy

- gxShell sends no telemetry.
- The optional update check is an unauthenticated read of the public GitHub release feed and can be disabled.
- CLI tunnels bind only to loopback and are temporary; close them after use.
- The CLI's HTTP listener address is hard-coded to `127.0.0.1:56789` and cannot
  be configured. There is no setting that exposes it on a routable interface —
  the only switch is on or off. A side effect worth naming since the project is
  AGPL-3.0: an unmodified gxShell has no remote network users, so section 13
  does not come into play in ordinary desktop use.

This model is a set of guardrails, not a sandbox. Review commands and secret
destinations before approving them, and rotate any credential that appears in a
prompt, process argument, terminal capture, or log.
