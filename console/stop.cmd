@echo off
rem Stop the Albert Console for good, whichever always-on mechanism is in use.
rem Order matters: silence the revive mechanisms first (the scheduled task's 1-minute
rem watchdog, and/or a run-forever.vbs supervisor), then kill the port owner directly:
rem killing only the launcher leaves node orphaned on port 4400.
powershell -NoProfile -Command ^
 "try { Disable-ScheduledTask -TaskName AlbertConsole -ErrorAction Stop | Out-Null; Write-Host 'watchdog task disabled. Re-enable with: Enable-ScheduledTask -TaskName AlbertConsole' } catch { };" ^
 "$vbs = '%~dp0run-forever.vbs';" ^
 "Get-CimInstance -ClassName Win32_Process | Where-Object { $_.Name -eq 'wscript.exe' -and $_.CommandLine -like ('*' + $vbs + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host 'supervisor stopped' };" ^
 "$c = Get-NetTCPConnection -LocalPort 4400 -State Listen -ErrorAction SilentlyContinue;" ^
 "if ($c) { Stop-Process -Id ($c.OwningProcess | Select-Object -First 1) -Force; Write-Host 'server stopped' } else { Write-Host 'server was not running' }"
