@echo off
rem Stop the Albert Console for good.
rem
rem Two steps are both required. Disabling the task first stops the 1-minute watchdog trigger, which
rem would otherwise revive the server within a minute. Then the port owner must be killed directly:
rem Stop-ScheduledTask only kills the wscript launcher and leaves node orphaned on port 4400.
powershell -NoProfile -Command ^
 "Disable-ScheduledTask -TaskName AlbertConsole | Out-Null;" ^
 "$c = Get-NetTCPConnection -LocalPort 4400 -State Listen -ErrorAction SilentlyContinue;" ^
 "if ($c) { Stop-Process -Id ($c.OwningProcess | Select-Object -First 1) -Force; Write-Host 'server stopped' } else { Write-Host 'server was not running' };" ^
 "Write-Host 'watchdog disabled. Re-enable with: Enable-ScheduledTask -TaskName AlbertConsole'"
