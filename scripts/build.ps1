# Builds the Prisca installer and copies it to dist\. Output mirrored to build.log.
$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $root 'build.log'
Set-Location $root
Set-Content -Path $log -Value "Prisca build $(Get-Date -Format s)" -Encoding UTF8
$ErrorActionPreference = 'Continue'
function Run($exe, [string[]]$argList) {
    & $exe @argList 2>&1 | ForEach-Object { $l = "$_"; Write-Host $l; Add-Content -Path $log -Value $l -Encoding UTF8 }
    return $LASTEXITCODE
}
if (-not (Test-Path (Join-Path $root 'node_modules'))) { [void](Run 'npm' @('install')) }
# Once updates are switched on (release-setup.cmd), builds must be signed with the update key.
$key = Join-Path $env:USERPROFILE '.prisca\updater.key'
if (Test-Path $key) {
    $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $key -Raw
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content (Join-Path $env:USERPROFILE '.prisca\updater.password.txt') -Raw).Trim()
}
$code = Run 'npm' @('run', 'build')
if ($code -ne 0) { Write-Host "Build failed (exit $code). See build.log." -ForegroundColor Red; exit $code }
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$setup = Get-ChildItem (Join-Path $root 'src-tauri\target\release\bundle\nsis') -Filter '*-setup.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($setup) {
    Copy-Item $setup.FullName $dist -Force
    Write-Host "Installer: $(Join-Path $dist $setup.Name)" -ForegroundColor Green
    Add-Content -Path $log -Value "Installer: $(Join-Path $dist $setup.Name)" -Encoding UTF8
}
