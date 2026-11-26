# Ordinary local builds stay in the project's standard output locations.
[CmdletBinding()]
param(
    [switch]$Clean,
    [switch]$DesktopOnly,
    [switch]$Development
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
try {
    Push-Location frontend
    try {
        if (-not (Test-Path node_modules)) {
            & npm.cmd ci
            if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed' }
        }
        if (-not $Development -or -not (Test-Path dist/index.html)) {
            & npm.cmd run build
            if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' }
        }
    } finally { Pop-Location }

    $arch = go env GOARCH
    $output = "gxShell_windows_$arch.syso"
    & wails3 generate syso -arch $arch -icon build/windows/icon.ico -manifest build/windows/wails.exe.manifest -info build/windows/info.json -out $output
    if ($LASTEXITCODE -ne 0) { throw 'Windows resource generation failed' }
    $desktopOutput = if ($Development) { 'build/bin/gxShell-dev.exe' } else { 'build/bin/gxShell.exe' }
    $buildArgs = @('build', '-o', $desktopOutput)
    if (-not $Development) { $buildArgs += @('-tags', 'production', '-trimpath', '-ldflags', '-s -w -H windowsgui') }
    if ($Clean) { $buildArgs += '-a' }
    & go @buildArgs .
    if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed' }
    Write-Output "Desktop executable: $(Join-Path $repo $desktopOutput)"
    Write-Output "Frontend bundle (embedded in desktop): $(Join-Path $repo 'frontend/dist')"
    if (-not $DesktopOnly) {
        & go build -o gxshell-cli.exe ./cmd/gxshell-cli
        if ($LASTEXITCODE -ne 0) { throw 'CLI build failed' }
        Write-Output "CLI executable: $(Join-Path $repo 'gxshell-cli.exe')"
    }
} finally {
    Pop-Location
}
