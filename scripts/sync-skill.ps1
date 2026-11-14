[CmdletBinding()]
param([switch]$Check)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$utf8 = [System.Text.UTF8Encoding]::new($false)
$sources = [ordered]@{
    'docs/agent-guide.md' = 'skills/gxshell/references/agent-guide.md'
    'docs/cli.md' = 'skills/gxshell/references/cli.md'
}
foreach ($entry in $sources.GetEnumerator()) {
    $source = Join-Path $repo $entry.Key
    $destination = Join-Path $repo $entry.Value
    $content = [IO.File]::ReadAllText($source, $utf8).Replace("`r`n", "`n")
    # Optional MCP setup remains online; installed skills retain the two local
    # references needed for CLI work without depending on a repository checkout.
    foreach ($name in @('mcp.md', 'mcp.zh-CN.md')) {
        $content = $content.Replace("($name)", "(https://github.com/gxmst/gxShell/blob/main/docs/$name)")
    }
    if ($Check) {
        if (-not (Test-Path -LiteralPath $destination) -or [IO.File]::ReadAllText($destination, $utf8) -cne $content) {
            throw "Skill reference is stale: $($entry.Value). Run scripts/sync-skill.ps1."
        }
    } else {
        $null = New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force
        [IO.File]::WriteAllText($destination, $content, $utf8)
    }
}
Write-Output $(if ($Check) { 'Skill references match the maintained documentation.' } else { 'Skill references synchronized.' })
