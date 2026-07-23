@echo off
rem Stop Albert Chat: kill whatever owns port 4401. Unlike the console there is no
rem watchdog task, so this one step is enough.
powershell -NoProfile -Command ^
 "$c = Get-NetTCPConnection -LocalPort 4401 -State Listen -ErrorAction SilentlyContinue;" ^
 "if ($c) { Stop-Process -Id ($c.OwningProcess | Select-Object -First 1) -Force; Write-Host 'chat stopped' } else { Write-Host 'chat was not running' }"
