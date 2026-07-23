@echo off
rem Restart the Albert Console (use this after changing server.mjs, lib/, or public/).
rem
rem Why not Stop-ScheduledTask + Start-ScheduledTask: the task's launcher (wscript) WAITS on node,
rem which is what keeps the task in Running state so the watchdog's IgnoreNew tick stays a no-op.
rem Stopping the task kills only wscript; node survives as an orphan still holding port 4400, so the
rem next start cannot bind and the OLD code keeps serving. Killing the port owner is the reliable path.
powershell -NoProfile -Command ^
 "$c = Get-NetTCPConnection -LocalPort 4400 -State Listen -ErrorAction SilentlyContinue;" ^
 "if ($c) { $old = $c.OwningProcess | Select-Object -First 1; Write-Host ('stopping node PID ' + $old); Stop-Process -Id $old -Force } else { Write-Host 'nothing listening on 4400' };" ^
 "Start-Sleep -Seconds 2;" ^
 "Start-ScheduledTask -TaskName AlbertConsole;" ^
 "Start-Sleep -Seconds 5;" ^
 "$n = Get-NetTCPConnection -LocalPort 4400 -State Listen -ErrorAction SilentlyContinue;" ^
 "if ($n) { Write-Host ('restarted: node PID ' + ($n.OwningProcess | Select-Object -First 1) + ' -> http://127.0.0.1:4400/') } else { Write-Host 'FAILED to come up. Check: Get-ScheduledTaskInfo -TaskName AlbertConsole' }"
