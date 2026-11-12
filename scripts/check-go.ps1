[CmdletBinding()]
param([switch]$Race)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
try {
    # Explicit roots cover our Go packages without entering npm dependencies.
    $packages = @('.', './backend/...', './cmd/...', './internal/...')
    $testArgs = @('test')
    if ($Race) { $testArgs += '-race' }
    & go @testArgs @packages
    if ($LASTEXITCODE -ne 0) { throw 'Go tests failed' }
    & go vet @packages
    if ($LASTEXITCODE -ne 0) { throw 'Go vet failed' }
} finally {
    Pop-Location
}
