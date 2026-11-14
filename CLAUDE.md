# Claude Code instructions

Before using `gxshell-cli`, follow [docs/agent-guide.md](docs/agent-guide.md). Use `exec-stdin` or `exec-file` for multiline scripts and heredocs, inspect structured JSON outcomes, and use `secret://` references instead of plaintext credentials.

The shared portable skill is maintained in [skills/gxshell/SKILL.md](skills/gxshell/SKILL.md),
with installation instructions in [skills/README.md](skills/README.md). It can be
installed for Claude Code or Codex; the two bundled references are synchronized
from the project documentation by `scripts/sync-skill.ps1` and checked in CI.
