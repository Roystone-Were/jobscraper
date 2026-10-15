# One-step setup, started by double-clicking setup.cmd: copies the scripts to
# %LOCALAPPDATA%\JobScraperLinkedIn (so the download folder can be deleted),
# runs one test push, and if it works, schedules it in Task Scheduler.

$ErrorActionPreference = "Stop"
$src = $PSScriptRoot
$dest = Join-Path $env:LOCALAPPDATA "JobScraperLinkedIn"
New-Item -ItemType Directory -Force -Path $dest | Out-Null

foreach ($f in "linkedin-push.ps1", "install-task.ps1", "uninstall.cmd") {
  Copy-Item (Join-Path $src $f) $dest -Force
}

$config = Join-Path $dest "linkedin-push.config.json"
if (Test-Path (Join-Path $src "linkedin-push.config.json")) {
  Copy-Item (Join-Path $src "linkedin-push.config.json") $config -Force
} elseif (-not (Test-Path $config)) {
  $worker = Read-Host "Worker URL (e.g. https://job-scraper.<subdomain>.workers.dev)"
  $key = Read-Host "LINKEDIN_PUSH_KEY"
  @{ worker = $worker.Trim(); key = $key.Trim() } | ConvertTo-Json | Set-Content $config -Encoding ASCII
}

# Files from a download or email are marked as "from the internet"; clear that.
Get-ChildItem $dest | Unblock-File

Write-Host ""
Write-Host "Testing: fetching LinkedIn from this PC (about 2 minutes)..." -ForegroundColor Cyan
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dest "linkedin-push.ps1")
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "The test did not work, so nothing was scheduled. Details: $(Join-Path $dest 'linkedin-push.log')" -ForegroundColor Red
  exit 1
}

Write-Host ""
& (Join-Path $dest "install-task.ps1")
Write-Host ""
Write-Host "All set. LinkedIn jobs will now reach Telegram while this PC is on." -ForegroundColor Green
Write-Host "To remove it later, double-click uninstall.cmd in $dest"
