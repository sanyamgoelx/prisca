# Starts Prisca in development mode and mirrors the output to dev.log.
$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $root 'dev.log'
Set-Location $root
Set-Content -Path $log -Value "Prisca dev run $(Get-Date -Format s)" -Encoding UTF8
$ErrorActionPreference = 'Continue'
if (-not (Test-Path (Join-Path $root 'node_modules'))) {
    Write-Host 'Installing the Tauri command line (first run only)...' -ForegroundColor Cyan
    & npm install 2>&1 | ForEach-Object { Write-Host $_; Add-Content -Path $log -Value "$_" -Encoding UTF8 }
}
Write-Host 'Starting Prisca. The first start compiles for a few minutes. Keep this window open; Ctrl+C stops it.' -ForegroundColor Cyan
& npm run dev 2>&1 | ForEach-Object {
    $line = "$_"
    Write-Host $line
    Add-Content -Path $log -Value $line -Encoding UTF8
}
