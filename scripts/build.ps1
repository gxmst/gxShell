# Ordinary local builds stay in the project's standard output locations.
[CmdletBinding()]
param(
    [switch]$Clean,
    [switch]$DesktopOnly
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
try {
    # Wails otherwise overwrites the maintained bindings before frontend checks.
    $buildArgs = @('build', '-skipbindings', '-m', '-nosyncgomod', '-nocolour')
    if ($Clean) { $buildArgs += '-clean' }
    & wails @buildArgs
    if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed' }
    Write-Output "Desktop executable: $(Join-Path $repo 'build/bin/gxShell.exe')"
    Write-Output "Frontend bundle (embedded in desktop): $(Join-Path $repo 'frontend/dist')"
    if (-not $DesktopOnly) {
        & go build -o gxshell-cli.exe ./cmd/gxshell-cli
        if ($LASTEXITCODE -ne 0) { throw 'CLI build failed' }
        Write-Output "CLI executable: $(Join-Path $repo 'gxshell-cli.exe')"
    }
} finally {
    Pop-Location
}
