@echo off
rem Double-click to stop the LinkedIn job pusher and remove it from this PC.
echo This stops LinkedIn jobs being sent from this PC.
pause
powershell.exe -NoProfile -Command "Unregister-ScheduledTask -TaskName 'Job Scraper LinkedIn' -Confirm:$false; Remove-Item -Recurse -Force '%LOCALAPPDATA%\JobScraperLinkedIn'; Write-Host Removed.; Start-Sleep 3"
