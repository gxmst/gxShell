[CmdletBinding(DefaultParameterSetName='Client')]
param(
    [Parameter(Mandatory=$true, ParameterSetName='Client')]
    [ValidateSet('claude', 'codex')]
    [string]$Client,
    [Parameter(Mandatory=$true, ParameterSetName='Destination')]
    [string]$Destination,
    [string]$Source = (Join-Path (Split-Path -Parent $PSScriptRoot) 'skills/gxshell'),
    [switch]$Update
)
$ErrorActionPreference = 'Stop'
$sourcePath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Source)
if ($PSCmdlet.ParameterSetName -eq 'Client') {
    $userProfilePath = [Environment]::GetFolderPath('UserProfile')
    if (-not $userProfilePath) { throw 'Cannot locate the user profile; use -Destination.' }
    $relative = if ($Client -eq 'claude') { '.claude/skills/gxshell' } else { '.agents/skills/gxshell' }
    $Destination = Join-Path $userProfilePath $relative
}
$destinationPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Destination)
if ($sourcePath.TrimEnd('\', '/') -eq $destinationPath.TrimEnd('\', '/')) {
    throw 'Source and installation destination must differ.'
}
$files = @('SKILL.md', 'references/agent-guide.md', 'references/cli.md')
foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourcePath $file) -PathType Leaf)) { throw "Skill source file missing: $file" }
}
if ((Test-Path -LiteralPath $destinationPath) -and -not $Update) {
    throw "Skill already exists at $destinationPath. Use -Update to replace the shipped files; extra files are retained."
}
foreach ($file in $files) {
    $sourceFile = Join-Path $sourcePath $file
    $destinationFile = Join-Path $destinationPath $file
    $null = New-Item -ItemType Directory -Path (Split-Path -Parent $destinationFile) -Force
    Copy-Item -LiteralPath $sourceFile -Destination $destinationFile -Force
    if ((Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $destinationFile -Algorithm SHA256).Hash) {
        throw "Installed file checksum mismatch: $file"
    }
}
Write-Output "Installed gxshell skill: $destinationPath"
Write-Output 'Use a new conversation; if the skill is not discovered, restart the AI client.'
