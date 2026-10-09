# One time: makes the key that signs updates, keeps it in %USERPROFILE%\.prisca,
# puts the public half in src-tauri\tauri.conf.json (which switches updates on),
# and gives the private half to GitHub (Actions secrets) so release builds can sign.
# Keep a copy of %USERPROFILE%\.prisca somewhere safe: without that key,
# installed copies can't update to newer versions.
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path $PSScriptRoot -Parent)
$log = Join-Path (Get-Location) "release-setup.log"
function Say($m) { Write-Host $m; Add-Content -Path $log -Value $m -Encoding utf8 }
"Prisca release setup $(Get-Date -Format s)" | Set-Content -Path $log -Encoding utf8

$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh) { $gh = "$env:ProgramFiles\GitHub CLI\gh.exe" }
$repo = "sanyamgoelx/prisca"
$dir = Join-Path $env:USERPROFILE ".prisca"
$key = Join-Path $dir "updater.key"
$pwFile = Join-Path $dir "updater.password.txt"

if (-not (Test-Path "node_modules")) { npm install 2>&1 | ForEach-Object { Say "  $_" } }
if (-not (Test-Path $key)) {
  New-Item -ItemType Directory -Force $dir | Out-Null
  $pw = [guid]::NewGuid().ToString("N")
  Set-Content -Path $pwFile -Value $pw -NoNewline -Encoding ascii
  npx tauri signer generate --ci -p $pw -w $key 2>&1 | ForEach-Object { Say "  $_" }
  if (-not (Test-Path $key)) { Say "COULDN'T MAKE THE KEY"; exit 1 }
  Say "Made the update-signing key in $dir"
} else {
  Say "Using the existing key in $dir"
}
$pw = (Get-Content $pwFile -Raw).Trim()
$pub = (Get-Content "$key.pub" -Raw).Trim()

# Switch updates on: public key + where to look for new versions.
$confPath = "src-tauri\tauri.conf.json"
$conf = Get-Content $confPath -Raw | ConvertFrom-Json
$conf.bundle | Add-Member -NotePropertyName createUpdaterArtifacts -NotePropertyValue $true -Force
$updater = [pscustomobject]@{
  pubkey = $pub
  endpoints = @("https://github.com/$repo/releases/latest/download/latest.json")
  windows = [pscustomobject]@{ installMode = "passive" }
}
if (-not $conf.PSObject.Properties["plugins"]) { $conf | Add-Member -NotePropertyName plugins -NotePropertyValue ([pscustomobject]@{}) }
$conf.plugins | Add-Member -NotePropertyName updater -NotePropertyValue $updater -Force
$json = $conf | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText((Resolve-Path $confPath), $json, (New-Object System.Text.UTF8Encoding $false))
Say "Updates switched on in $confPath"

Get-Content $key -Raw | & $gh secret set TAURI_SIGNING_PRIVATE_KEY --repo $repo 2>&1 | ForEach-Object { Say "  $_" }
$pw | & $gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo $repo 2>&1 | ForEach-Object { Say "  $_" }
$names = & $gh secret list --repo $repo 2>&1
Say "GitHub secrets now: $($names -join ', ')"
if (($names -join " ") -match "TAURI_SIGNING_PRIVATE_KEY_PASSWORD") { Say "RELEASE SETUP DONE" } else { Say "SECRETS NOT SET" }
