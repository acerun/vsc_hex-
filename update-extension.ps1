param(
    [string]$CodeCli = 'code.cmd'
)

$ErrorActionPreference = 'Stop'

Push-Location $PSScriptRoot
try {
    & npm.cmd run compile
    if ($LASTEXITCODE -ne 0) {
        throw 'Extension compilation failed.'
    }

    & npm.cmd run package
    if ($LASTEXITCODE -ne 0) {
        throw 'VSIX packaging failed.'
    }

    $manifest = Get-Content (Join-Path $PSScriptRoot 'package.json') -Raw | ConvertFrom-Json
    $vsixPath = Join-Path $PSScriptRoot ("{0}-{1}.vsix" -f $manifest.name, $manifest.version)
    if (-not (Test-Path -LiteralPath $vsixPath -PathType Leaf)) {
        throw "Packaged VSIX not found: $vsixPath"
    }

    & $CodeCli --install-extension $vsixPath --force
    if ($LASTEXITCODE -ne 0) {
        throw 'VS Code extension installation failed.'
    }

    Write-Host "Updated $($manifest.publisher).$($manifest.name). Reload the VS Code window to activate it."
} finally {
    Pop-Location
}
