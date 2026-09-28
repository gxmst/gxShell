# Build a local release candidate without publishing or touching old archives.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
try {
    & wails build -skipbindings -m -nosyncgomod -nocolour
    if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed' }
    & go build -o gxshell-cli.exe ./cmd/gxshell-cli
    if ($LASTEXITCODE -ne 0) { throw 'CLI build failed' }
    $source = Get-Content backend/version/version.go -Raw
    if ($source -notmatch 'const\s+Version\s*=\s*"([^"]+)"') { throw 'Version missing' }
    $version = $Matches[1]
    $commit = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Cannot identify commit' }
    $state = @(& git status --porcelain)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect working tree' }
    $suffix = if ($state.Count) { '-dirty' } else { '' }
    $leaf = "$(Get-Date -Format 'yyyyMMdd-HHmmss-fff')-$($commit.Substring(0,7))$suffix"
    $archive = Join-Path (Split-Path -Parent $repo) "_build_artifacts/gxShell/$leaf"
    if (Test-Path -LiteralPath $archive) { throw 'Archive already exists' }
    $null = New-Item -ItemType Directory -Path $archive
    $null = New-Item -ItemType Directory -Path (Join-Path $archive 'CLI')
    $files = [ordered]@{
        'build/bin/gxShell.exe' = 'gxShell.exe'
        'gxshell-cli.exe' = 'CLI/gxshell-cli.exe'
        'LICENSE' = 'LICENSE'
        'docs/cli.md' = 'CLI/CLI-README.md'
        'docs/cli.zh-CN.md' = 'CLI/CLI-README.zh-CN.md'
        'docs/agent-guide.md' = 'CLI/agent-guide.md'
    }
    foreach ($item in $files.GetEnumerator()) {
        $destination = Join-Path $archive $item.Value
        Copy-Item -LiteralPath $item.Key -Destination $destination
        if ((Get-FileHash -LiteralPath $item.Key).Hash -ne (Get-FileHash -LiteralPath $destination).Hash) {
            throw "Copy checksum mismatch: $($item.Value)"
        }
    }
    $reported = & (Join-Path $archive 'CLI/gxshell-cli.exe') version
    if ($LASTEXITCODE -ne 0 -or $reported -ne "gxshell-cli version $version") { throw 'Archived CLI smoke test failed' }
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    $manifest = @(
        'gxShell local release candidate (not published)',
        "version: $version", "commit: $commit", "dirty: $([bool]$state.Count)",
        'platform: windows/amd64', "built_at_utc: $((Get-Date).ToUniversalTime().ToString('o'))",
        'desktop: Wails production build; bindings retained',
        'validation: see workspace review report; exact-commit CI required before tagging',
        'smoke: archived CLI version verified; native desktop startup not tested',
        'assets:'
    ) + @($files.Values | ForEach-Object { "  $_" }) + @('  BUILD-MANIFEST.txt')
    [IO.File]::WriteAllText((Join-Path $archive 'BUILD-MANIFEST.txt'), (($manifest -join "`n") + "`n"), $utf8)
    $inputs = @(Get-ChildItem -LiteralPath $archive | Select-Object -ExpandProperty FullName)
    $package = Join-Path $archive "gxShell-v$version-windows-amd64.zip"
    Compress-Archive -LiteralPath $inputs -DestinationPath $package -CompressionLevel Optimal
    $checksums = Get-ChildItem -LiteralPath $archive -File -Recurse | Sort-Object FullName | ForEach-Object {
        $relative = $_.FullName.Substring($archive.Length + 1).Replace('\', '/')
        "$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $relative"
    }
    [IO.File]::WriteAllText((Join-Path $archive 'SHA256SUMS.txt'), (($checksums -join "`n") + "`n"), $utf8)
    Write-Output "Archive: $archive"
    Write-Output "Package: $package"
} finally {
    Pop-Location
}
