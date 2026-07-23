# Launch a detached, visible Claude Code session running an /albert goal.
#
# Invoked by the chat backend as:
#   powershell -NoProfile -ExecutionPolicy Bypass -File launch_run.ps1 -Project <dir> -Prompt <text>
#
# Why this wrapper exists: `claude` on this box is an npm .cmd shim, which CreateProcess
# cannot exec directly from Python, and inline `powershell -Command` quoting mangles
# arguments with spaces. `-File` parameter binding keeps every boundary clean, and
# Start-Process gives the run its own console window that survives the chat app exiting.
# The prompt must not contain double quotes (the caller strips them).
param(
  [Parameter(Mandatory = $true)][string]$Project,
  [Parameter(Mandatory = $true)][string]$Prompt
)

if (-not (Test-Path -LiteralPath $Project -PathType Container)) {
  Write-Error "project directory not found: $Project"
  exit 1
}
if ($Prompt -match '"') {
  Write-Error 'prompt must not contain double quotes'
  exit 1
}

$claude = (Get-Command claude.cmd -ErrorAction SilentlyContinue).Source
if (-not $claude) {
  $claude = (Get-Command claude -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1).Source
}
if (-not $claude) {
  Write-Error 'claude CLI not found on PATH'
  exit 1
}

Start-Process -FilePath $claude -WorkingDirectory $Project -ArgumentList ('"{0}"' -f $Prompt)
