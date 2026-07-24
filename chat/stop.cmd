@echo off
rem Stop Albert Chat for good. Kill the run-forever supervisor first if one is running,
rem otherwise it relaunches the server within seconds; then kill the port owner.
powershell -NoProfile -Command ^
 "$vbs = '%~dp0run-forever.vbs';" ^
 "Get-CimInstance -ClassName Win32_Process | Where-Object { $_.Name -eq 'wscript.exe' -and $_.CommandLine -like ('*' + $vbs + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force };" ^
 "$c = Get-NetTCPConnection -LocalPort 4401 -State Listen -ErrorAction SilentlyContinue;" ^
 "if ($c) { Stop-Process -Id ($c.OwningProcess | Select-Object -First 1) -Force; Write-Host 'chat stopped' } else { Write-Host 'chat was not running' }"
