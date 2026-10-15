# Registers a Task Scheduler task that runs linkedin-push.ps1 every 30 minutes,
# 07:00-19:00, while you are signed in. No admin rights needed.
# Run once:   powershell -ExecutionPolicy Bypass -File install-task.ps1
# Remove:     Unregister-ScheduledTask -TaskName "Job Scraper LinkedIn" -Confirm:$false

param([int]$EveryMinutes = 30, [string]$From = "07:00", [int]$ForHours = 12)

$taskName = "Job Scraper LinkedIn"
$script = Join-Path $PSScriptRoot "linkedin-push.ps1"
if (-not (Test-Path (Join-Path $PSScriptRoot "linkedin-push.config.json"))) {
  throw "Create linkedin-push.config.json next to this script first (see README.md)."
}

$psArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
# conhost --headless runs it with no window at all; older Windows briefly flashes one instead.
if ([Environment]::OSVersion.Version.Build -ge 22000) {
  $action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument "--headless powershell.exe $psArgs"
} else {
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $psArgs
}

$trigger = New-ScheduledTaskTrigger -Daily -At $From
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At $From `
  -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes) -RepetitionDuration (New-TimeSpan -Hours $ForHours)).Repetition

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Principal $principal -Description "Pushes LinkedIn job searches to the job-scraper Worker." -Force | Out-Null
Write-Host "Installed '$taskName': every $EveryMinutes min from $From for $ForHours h. Log: $(Join-Path $PSScriptRoot 'linkedin-push.log')"
