# Claude Code instructions

Before using `gxshell-cli`, follow [GXSHELL_AGENT_GUIDE.md](GXSHELL_AGENT_GUIDE.md). Use `exec-stdin` or `exec-file` for multiline scripts and heredocs, inspect structured JSON outcomes, and use `secret://` references instead of plaintext credentials.

A packaged version of that contract, with bash examples and task recipes, is
installed as the `gxshell` skill (`~/.claude/skills/gxshell/SKILL.md`). The guide
above remains the source of truth: it is model-independent and ships with the
repo, while the skill is a local convenience that has to be updated alongside it.
