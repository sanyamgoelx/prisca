# Puts Prisca on GitHub as a public repository (one time), then pushes the latest code.
# Sign-in uses the GitHub CLI (already signed in if Convertino was published from this PC).
$ErrorActionPreference = "Continue"  # git and gh write progress to stderr
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location (Split-Path $PSScriptRoot -Parent)
$log = Join-Path (Get-Location) "github.log"
function Say($m) { Write-Host $m; Add-Content -Path $log -Value $m -Encoding utf8 }
"Prisca GitHub $(Get-Date -Format s)" | Set-Content -Path $log -Encoding utf8
$env:GIT_TERMINAL_PROMPT = "0"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Say "Git isn't installed."; exit 1 }
function Find-Gh {
  $c = Get-Command gh -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @("$env:ProgramFiles\GitHub CLI\gh.exe", "$env:LOCALAPPDATA\Programs\GitHub CLI\gh.exe")) { if (Test-Path $p) { return $p } }
  return $null
}
$gh = Find-Gh
if (-not $gh) {
  Say "Installing the GitHub CLI..."
  winget install --id GitHub.cli -e --silent --accept-source-agreements --accept-package-agreements 2>&1 | ForEach-Object { Say "  $_" }
  $gh = Find-Gh
  if (-not $gh) { Say "The GitHub CLI didn't install."; exit 1 }
}
& $gh auth status --hostname github.com *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Signing in to GitHub: copy the one-time code shown below, press Enter, and paste it in the browser page that opens."
  & $gh auth login --hostname github.com --git-protocol https --web
  if ($LASTEXITCODE -ne 0) { Say "GitHub sign-in didn't finish."; exit 1 }
}
& $gh auth setup-git --hostname github.com | Out-Null
$user = (& $gh api user --jq .login).Trim()
Say "Signed in as: $user"
if ($user -ne "sanyamgoelx") { Say "Signed in as $user, not sanyamgoelx: personal tools go under sanyamgoelx. Stopping."; exit 1 }

if (-not (Test-Path ".git")) { git init -b main | Out-Null; Say "Made a git repository here." }
$uid = (& $gh api user --jq .id).Trim()
git config user.name $user
git config user.email "$uid+$user@users.noreply.github.com"
git config core.autocrlf true
if (Test-Path ".git\index.lock") { Remove-Item ".git\index.lock" -Force -ErrorAction SilentlyContinue }

git add -A
$pending = git status --porcelain
if ($pending) {
  git commit -q -m "Prisca: latest changes" | Out-Null
  Say "Committed $(@($pending).Count) file(s)."
}

$url = "https://github.com/$user/prisca.git"
if (git remote 2>$null | Select-String -SimpleMatch "origin") { git remote set-url origin $url } else { git remote add origin $url }
& $gh repo view "$user/prisca" *> $null
if ($LASTEXITCODE -ne 0) {
  Say "Creating the public repository $user/prisca..."
  & $gh repo create "$user/prisca" --public --description "Fast scanning for any scanner or all-in-one printer on Windows" 2>&1 | ForEach-Object { Say "  $_" }
  if ($LASTEXITCODE -ne 0) { Say "COULDN'T CREATE THE REPOSITORY"; exit 1 }
}
Say "Pushing to $url ..."
git push -u origin main 2>&1 | ForEach-Object { Say "$_" }
if ($LASTEXITCODE -ne 0) { Say "PUSH FAILED (exit $LASTEXITCODE)"; exit $LASTEXITCODE }
Say "PUSHED: https://github.com/$user/prisca"
Say "Builds: https://github.com/$user/prisca/actions"
