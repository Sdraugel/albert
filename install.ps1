<#
.SYNOPSIS
  Installs the Albert harness and the Albert Console on this machine.

.DESCRIPTION
  Copies the harness (the /albert skill, the agent roster, the parallel executor, and the
  event emitter) into your Claude Code config, resolving every machine-path template token to
  your own environment. Then installs the Albert Console and, unless told not to, registers it
  as an always-on background task that serves http://localhost:4400.

  Nothing from the author's machine is shipped or installed. Everything is generated from your
  paths at install time.

.PARAMETER ClaudeDir
  Your Claude Code config directory. Default: %USERPROFILE%\.claude

.PARAMETER ProjectsDir
  The folder your code projects live under (used only as context in the harness prompts).
  Default: the parent folder of this repo.

.PARAMETER ConsoleDir
  Where the runnable console copy is installed. Default: %LOCALAPPDATA%\AlbertConsole

.PARAMETER Port
  Port for the -DemoOnly foreground console. The always-on task always serves 4400.

.PARAMETER DemoOnly
  Skip installation. Generate synthetic demo data and open the console against it, so you can
  see the UI without running anything real.

.PARAMETER NoConsole
  Install the harness only. Do not install or register the console.

.PARAMETER NoTask
  Install the console files but do not register the always-on scheduled task.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -DemoOnly
#>
[CmdletBinding()]
param(
  [string]$ClaudeDir   = (Join-Path $env:USERPROFILE '.claude'),
  [string]$ProjectsDir = (Split-Path -Parent $PSScriptRoot),
  [string]$ConsoleDir  = (Join-Path $env:LOCALAPPDATA 'AlbertConsole'),
  [int]$Port           = 4400,
  [switch]$DemoOnly,
  [switch]$NoConsole,
  [switch]$NoTask
)

$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
function Info($m) { Write-Host "  $m" }
function Ok($m)   { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m"  -ForegroundColor Yellow }
function Step($m) { Write-Host "`n$m" -ForegroundColor Cyan }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is not on PATH. Install Node 20+ (26 recommended) and re-run."
}

# Writes $src to $dst with the three path tokens resolved. UTF-8, no BOM, line endings kept.
# -JsEscape doubles backslashes for tokens that sit inside JavaScript string literals.
function Install-File {
  param([string]$Src, [string]$Dst, [switch]$JsEscape)
  $text = [System.IO.File]::ReadAllText($Src)
  $claude = $ClaudeDir; $projects = $ProjectsDir; $console = $ConsoleDir
  if ($JsEscape) {
    $claude   = $claude.Replace('\', '\\')
    $projects = $projects.Replace('\', '\\')
    $console  = $console.Replace('\', '\\')
  }
  $text = $text.Replace('{{CLAUDE_DIR}}', $claude).Replace('{{PROJECTS_DIR}}', $projects).Replace('{{CONSOLE_DIR}}', $console)
  $dstDir = Split-Path -Parent $Dst
  if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Force -Path $dstDir | Out-Null }
  [System.IO.File]::WriteAllText($Dst, $text)
}

# --- Demo mode: no install, just show the UI on fabricated data ----------------------------
if ($DemoOnly) {
  Step "Generating synthetic demo data"
  $demoDir = Join-Path $repo 'tools\demo-out'
  node (Join-Path $repo 'tools\make-demo-data.mjs') $demoDir
  Ok "demo data at $demoDir"
  Step "Starting the console at http://localhost:$Port  (Ctrl+C to stop)"
  Start-Process "http://localhost:$Port"
  node (Join-Path $repo 'console\server.mjs') `
    --port $Port `
    --store   (Join-Path $demoDir 'agent-runs') `
    --projects (Join-Path $demoDir 'projects') `
    --agents  (Join-Path $repo 'harness\agents')
  return
}

Write-Host "`nInstalling Albert" -ForegroundColor Cyan
Write-Host "  ClaudeDir   : $ClaudeDir"
Write-Host "  ProjectsDir : $ProjectsDir"
Write-Host "  ConsoleDir  : $ConsoleDir"

# --- Harness --------------------------------------------------------------------------------
Step "Installing harness into Claude Code config"

Install-File (Join-Path $repo 'harness\skills\albert\SKILL.md') (Join-Path $ClaudeDir 'skills\albert\SKILL.md')
Ok "skill: /albert"

# loop-* agents are ours and always overwrite. The six generic helper agents are only placed
# if you do not already have your own copy under agents\, so we never clobber your versions.
$genericDeps = @('code-reviewer','security-reviewer','performance-reviewer','doc-writer','refactor-worker','codebase-locator')
$skippedDeps = @()
foreach ($f in Get-ChildItem (Join-Path $repo 'harness\agents') -Filter *.md) {
  $name = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)
  $dst  = Join-Path $ClaudeDir "agents\$($f.Name)"
  if (($genericDeps -contains $name) -and (Test-Path $dst)) { $skippedDeps += $name; continue }
  Install-File $f.FullName $dst
}
Ok "agents: 11 loop-* roster + generic helpers"
if ($skippedDeps) { Info ("kept your existing helper agents: " + ($skippedDeps -join ', ')) }

Install-File (Join-Path $repo 'harness\workflows\chunk-exec.js') (Join-Path $ClaudeDir 'workflows\chunk-exec.js') -JsEscape
Ok "workflow: chunk-exec (parallel executor)"

Install-File (Join-Path $repo 'harness\runtime\_emit.mjs')            (Join-Path $ClaudeDir 'agent-runs\_emit.mjs')
Install-File (Join-Path $repo 'harness\runtime\agent-runs-README.md') (Join-Path $ClaudeDir 'agent-runs\README.md')
Ok "run store: _emit.mjs + README (existing run data left untouched)"

# --- Console --------------------------------------------------------------------------------
if (-not $NoConsole) {
  Step "Installing Albert Console"
  foreach ($f in Get-ChildItem (Join-Path $repo 'console') -Recurse -File) {
    $rel = $f.FullName.Substring((Join-Path $repo 'console').Length).TrimStart('\')
    Install-File $f.FullName (Join-Path $ConsoleDir $rel)
  }
  Ok "console installed at $ConsoleDir"

  if (-not $NoTask) {
    $vbs = Join-Path $ConsoleDir 'run-hidden.vbs'
    $action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"{0}"' -f $vbs)
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    # A 1-minute repetition is the watchdog: if the console dies, the next tick relaunches it.
    # (Task Scheduler's own restart-on-failure proved unreliable for this.)
    try {
      $rep = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
               -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration ([TimeSpan]::MaxValue)
    } catch {
      $rep = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
               -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
    }
    $trigger.Repetition = $rep.Repetition
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
                  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName 'AlbertConsole' -Action $action -Trigger $trigger `
      -Settings $settings -Description 'Albert Console (Albert monitor)' -Force | Out-Null
    Start-ScheduledTask -TaskName 'AlbertConsole'
    Ok "registered always-on task 'AlbertConsole' -> http://localhost:4400"
  } else {
    Info "console task not registered (-NoTask). Start it manually with: $ConsoleDir\start.cmd"
  }
}

# --- Done -----------------------------------------------------------------------------------
Step "Installed."
Write-Host "  Run a goal from any project:  " -NoNewline; Write-Host '/albert "<your goal>"' -ForegroundColor White
if (-not $NoConsole -and -not $NoTask) { Write-Host "  Watch it live:                http://localhost:4400" }
Write-Host "  Remove everything:            .\uninstall.ps1`n"
