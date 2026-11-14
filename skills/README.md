# Install the gxShell skill / 安装 gxShell Skill

The portable skill lives in `gxshell/`. It includes the current CLI agent
contract and command reference. It supplies instructions, not the desktop app,
CLI executable, SSH profiles or credentials.

这份 Skill 位于 `gxshell/`，随目录携带当前的 Agent 规范和 CLI 使用说明。
它只提供操作指引，不会安装 gxShell、CLI、服务器配置或凭据。

## Install once on a new computer / 新电脑安装一次

From the repository root, or the root of a future release that includes this
skill, ask your agent:

> Install the gxshell skill from skills/gxshell for Claude Code (or Codex).
> Read skills/README.md and use scripts/install-skill.ps1.

从仓库根目录，或将来包含 Skill 的发布包根目录，可以直接对 Agent 说：

> 这里的 skills/gxshell 是 gxShell Skill，请按 skills/README.md 给 Claude Code
> （或 Codex）安装，用 scripts/install-skill.ps1。

```powershell
# Claude Code
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/install-skill.ps1 -Client claude

# Codex
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/install-skill.ps1 -Client codex
```

User-level destinations / 用户级安装位置：

| Client / 客户端 | Destination / 目录 |
| --- | --- |
| Claude Code | `~/.claude/skills/gxshell/` |
| Codex | `~/.agents/skills/gxshell/` |

The script defaults to preserving an existing installation. To update it,
repeat the command with `-Update`; this replaces the three shipped files and
retains any extra files. Back up edits to those shipped files first if you need
them. `-Destination <skill-folder>` supports a client-specific or project-level
location; use `-Source <source-folder>` when installing from another checkout.

默认不会覆盖已有安装。更新时在命令后加 `-Update`：它会替换随 Skill 提供的三个
文件，并保留额外文件；如需保留对这三个文件的个人改动，请先备份。
`-Destination <Skill目录>` 可指定项目级或其他客户端的位置，
`-Source <来源目录>` 可从另一份仓库安装。

After installation, use a new conversation and refer to the `gxshell` skill.
Codex detects skill changes automatically; restart it if the skill does not
appear. For Claude Code, restart or open a new session if discovery is stale.
Clients without skill discovery can read `gxshell/SKILL.md` directly.

安装后开新对话即可指明使用 `gxshell` Skill。Codex 会自动发现 Skill 变更；如未显示，
重启客户端。Claude Code 如未发现则重启或开启新会话。不支持 Skill 自动发现的
工具，也可以直接读取 `gxshell/SKILL.md`。

On that computer, separately install gxShell and its CLI, enable **CLI / MCP
server**, restart gxShell, and grant alias-based access to the intended profiles.
Put the CLI on `PATH` or tell the agent its executable path. Installed skills do
not synchronize between computers and do not update when you only run `git pull`;
rerun the installer after updating the source.

新电脑仍需单独安装 gxShell 和 CLI，在设置中开启「CLI / MCP 服务」、重启 gxShell，
并为目标服务器启用访问及别名。将 CLI 加入 `PATH` 或告诉 Agent 可执行文件的位置。
Skill 不会跨电脑自动同步；只更新仓库也不会更新已经安装的副本，需要重新运行安装脚本。

## Maintain the skill / 维护 Skill

Edit `gxshell/SKILL.md` for the compact operating guidance. The two reference
files are generated from `docs/agent-guide.md` and `docs/cli.md`; update those
maintained documents and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/sync-skill.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/sync-skill.ps1 -Check
```

`-Check` performs no writes and runs in Windows CI and packaging checks. Do not
edit generated references directly. The release workflow and local archived
build include `skills/` plus the installer. Already published release archives
remain unchanged.

两个 reference 文件由 `docs/agent-guide.md` 和 `docs/cli.md` 生成；先修改规范源文件，
再运行同步脚本。`-Check` 只读核对，并用于 Windows CI 和打包检查。请勿直接改生成的
reference 文件。后续 CI 发布和本地归档会携带 `skills/` 及安装脚本；已发布的压缩包不变。

Codex discovery reference: <https://developers.openai.com/codex/skills/>
