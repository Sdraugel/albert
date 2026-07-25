<#
.SYNOPSIS
  Removes the Albert harness and the Albert Console from this machine.

.DESCRIPTION
  Undoes install.ps1. Stops every always-on mechanism (the AlbertConsole scheduled task,
  the run-forever.vbs supervisors, and the HKCU Run autostart entries), frees the console
  and chat ports, deletes the installed console copy, and removes the harness files that
  this project installed into your Claude Code config.

  Albert Chat lives in the repo you cloned, so its files are left alone; this only stops it
  and removes its autostart entry.

  It does NOT delete your run history (the data folders under <ClaudeDir>\agent-runs\<run-id>),
  and it does NOT remove the six generic helper agents (code-reviewer, security-reviewer,
  performance-reviewer, doc-writer, refactor-worker, codebase-locator), because you may have
  had your own copies before installing. Both are reported so you can remove them by hand if
  you want.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
#>
[CmdletBinding()]
param(
  [string]$ClaudeDir  = (Join-Path $env:USERPROFILE '.claude'),
  [string]$ConsoleDir = (Join-Path $env:LOCALAPPDATA 'AlbertConsole'),
  [int]$Port          = 4400,
  [int]$ChatPort      = 4401
)

$ErrorActionPreference = 'Stop'
function Info($m) { Write-Host "  $m" }
function Ok($m)   { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m"  -ForegroundColor Yellow }

Write-Host "`nRemoving Albert" -ForegroundColor Cyan
Write-Host "  ClaudeDir  : $ClaudeDir"
Write-Host "  ConsoleDir : $ConsoleDir`n"

# 1. Scheduled task + port owner ------------------------------------------------------------
try {
  $task = Get-ScheduledTask -TaskName 'AlbertConsole' -ErrorAction SilentlyContinue
  if ($task) {
    # Disable first so the 1-minute watchdog cannot relaunch node while we kill it.
    Disable-ScheduledTask -TaskName 'AlbertConsole' -ErrorAction SilentlyContinue | Out-Null
    Stop-ScheduledTask    -TaskName 'AlbertConsole' -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName 'AlbertConsole' -Confirm:$false
    Ok "unregistered scheduled task AlbertConsole"
  } else {
    Info "no AlbertConsole scheduled task registered"
  }
} catch { Warn "could not remove scheduled task: $($_.Exception.Message)" }

# HKCU Run entries: the alternative always-on mechanism (used when Task Scheduler is
# unavailable). Remove BEFORE killing anything, so a supervisor cannot come back at logon.
foreach ($name in 'AlbertConsole', 'AlbertChat') {
  try {
    $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    if ((Get-ItemProperty -Path $runKey -Name $name -ErrorAction SilentlyContinue)) {
      Remove-ItemProperty -Path $runKey -Name $name -ErrorAction Stop
      Ok "removed autostart entry $name"
    }
  } catch { Warn "could not remove autostart entry $name : $($_.Exception.Message)" }
}

# run-forever.vbs supervisors relaunch their server seconds after it dies, so they must go
# before the port owners. Matched on the script name in the wscript command line.
try {
  $supervisors = Get-CimInstance Win32_Process -Filter "Name = 'wscript.exe'" -ErrorAction SilentlyContinue |
                 Where-Object { $_.CommandLine -like '*run-forever.vbs*' }
  foreach ($s in $supervisors) {
    Stop-Process -Id $s.ProcessId -Force -ErrorAction SilentlyContinue
    Ok "stopped supervisor process $($s.ProcessId)"
  }
} catch { Warn "could not stop supervisors: $($_.Exception.Message)" }

# Kill whatever still owns the console and chat ports (orphans the launchers leave behind).
foreach ($p in $Port, $ChatPort) {
  try {
    $owners = (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
               Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($procId in $owners) {
      Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
      Ok "stopped process $procId holding port $p"
    }
  } catch { Warn "could not free port $p : $($_.Exception.Message)" }
}

# 2. Console install copy -------------------------------------------------------------------
if (Test-Path $ConsoleDir) {
  Remove-Item -Recurse -Force $ConsoleDir
  Ok "removed console at $ConsoleDir"
} else {
  Info "no console install found at $ConsoleDir"
}

# 3. Harness files we own -------------------------------------------------------------------
$loopAgents = @(
  'loop-planner','loop-worker','loop-data-scientist','loop-designer','loop-researcher',
  'loop-devops','loop-verifier-dev','loop-qa','loop-skeptic-research','loop-cleanup','loop-scribe'
)
$ownedPaths = @(
  (Join-Path $ClaudeDir 'skills\albert'),
  (Join-Path $ClaudeDir 'workflows\chunk-exec.js'),
  (Join-Path $ClaudeDir 'agent-runs\_emit.mjs'),
  (Join-Path $ClaudeDir 'agent-runs\_inbox.mjs')
) + ($loopAgents | ForEach-Object { Join-Path $ClaudeDir "agents\$_.md" })

foreach ($p in $ownedPaths) {
  if (Test-Path $p) {
    Remove-Item -Recurse -Force $p
    Ok "removed $p"
  }
}

# 4. What we intentionally left ------------------------------------------------------------
$genericDeps = @('code-reviewer','security-reviewer','performance-reviewer','doc-writer','refactor-worker','codebase-locator')
$leftDeps = $genericDeps | Where-Object { Test-Path (Join-Path $ClaudeDir "agents\$_.md") }
if ($leftDeps) {
  Warn ("left generic helper agents in place (remove by hand if unwanted): " + ($leftDeps -join ', '))
}
$runStore = Join-Path $ClaudeDir 'agent-runs'
if ((Test-Path $runStore) -and (Get-ChildItem $runStore -Directory -ErrorAction SilentlyContinue)) {
  Warn "left your run history under $runStore (delete manually to erase it)"
}

Write-Host "`nDone.`n" -ForegroundColor Cyan
