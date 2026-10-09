# Publishes the version in src-tauri\tauri.conf.json: pushes the latest code,
# waits for its Build run to pass, then pushes the tag v<version>, which starts
# the Release build on GitHub. Installed copies then update themselves.
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path $PSScriptRoot -Parent)
$log = Join-Path (Get-Location) "release.log"
function Say($m) { Write-Host $m; Add-Content -Path $log -Value $m -Encoding utf8 }
"Prisca release $(Get-Date -Format s)" | Set-Content -Path $log -Encoding utf8
$env:GIT_TERMINAL_PROMPT = "0"
$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh) { $gh = "$env:ProgramFiles\GitHub CLI\gh.exe" }

$version = (Get-Content "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json).version
$tag = "v$version"
Say "Version $version"
& powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\publish-github.ps1"
git fetch --tags --quiet 2>&1 | Out-Null
if (git tag --list $tag) {
  Say "$tag was released already. Raise the version in src-tauri\tauri.conf.json, package.json and src-tauri\Cargo.toml first."
  exit 1
}
$sha = (git rev-parse HEAD).Trim()
Say "Waiting for the Build checks of $($sha.Substring(0, 7))..."
$deadline = (Get-Date).AddMinutes(45)
while ($true) {
  $runs = & $gh run list --repo sanyamgoelx/prisca --workflow build.yml --commit $sha --json status,conclusion,url --limit 1 2>$null | ConvertFrom-Json
  if ($runs -and $runs[0].status -eq "completed") {
    if ($runs[0].conclusion -eq "success") { Say "Build checks passed."; break }
    Say "Build checks FAILED ($($runs[0].conclusion)): $($runs[0].url)"
    Say "Not releasing."
    exit 1
  }
  if ((Get-Date) -gt $deadline) { Say "Build checks didn't finish in 45 minutes; not releasing."; exit 1 }
  Start-Sleep -Seconds 45
}
git tag -a $tag -m "Prisca $version" 2>&1 | ForEach-Object { Say "  $_" }
git push origin $tag 2>&1 | ForEach-Object { Say "  $_" }
if ($LASTEXITCODE -ne 0) { Say "TAG PUSH FAILED"; exit 1 }
Say "RELEASING ${tag}: https://github.com/sanyamgoelx/prisca/actions (then https://github.com/sanyamgoelx/prisca/releases)"
