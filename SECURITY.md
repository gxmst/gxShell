# Security Policy

## Supported versions

Security fixes land on the latest release line. Please update to the newest
`v1.6.x` release before reporting; older releases are not patched
retroactively.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:
https://github.com/gxmst/gxShell/security/advisories/new

Please do not open a public issue for security problems. Include:

- a description of the problem and its impact;
- the affected version (and commit, if building from source);
- reproduction steps or a proof of concept;
- any logs or output, with credentials and secrets removed.

You can expect an acknowledgement within three business days. We will credit
reporters in the fix's changelog entry unless you prefer to remain anonymous.

## Scope

gxShell is a local desktop application whose security model is documented in
[docs/security.md](docs/security.md). Especially valuable reports include:

- anything that exposes saved SSH credentials, key passphrases, AI API keys,
  or named secrets beyond the documented redaction limits;
- approval or trust-window bypasses: a path that executes a command without
  the native click the tier model promises, or that keeps trust alive past its
  expiry;
- the CLI token: how it is stored, transported, and validated against the
  local HTTP listener;
- SSH host key verification (TOFU storage, key-change handling);
- the T0-T3 command classifier letting visible, promised-readable commands
  mutate state;
- the renderer (WebView) reaching privileged backend operations it should not.

Known, documented limitations are not vulnerabilities: the docs state openly
that classification is a guardrail for cooperative automation, not
containment against a malicious local token holder, and that encoded or
transformed payloads can evade text analysis. Attacks that require an
already-compromised local user account are in scope only where they defeat a
specific documented guarantee (for example a web page reaching the loopback
daemon, or another local user reading the CLI token file).

## Secure development

- The release build is reproducible from this repository; release zips ship
  with `SHA256SUMS.txt`.
- CI runs `go test -race ./...`, `go vet ./...`, `govulncheck ./...`, frontend
  lint/tests, and the custom i18n/bindings/css/version gates on every push.
- Dependabot keeps Go, npm, and GitHub Actions dependencies current.
