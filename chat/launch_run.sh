#!/usr/bin/env bash
# Launch a detached, visible Claude Code session running an /albert goal.
#
# Invoked by the chat backend as:
#   bash launch_run.sh --project <dir> --prompt <text>
#
# On macOS this opens a new Terminal.app window (mirrors Windows Start-Process).
# The prompt must not contain double quotes (the caller strips them).
set -euo pipefail

PROJECT=""
PROMPT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --prompt)  PROMPT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

[[ -n "$PROJECT" && -n "$PROMPT" ]] || { echo "usage: $0 --project DIR --prompt TEXT" >&2; exit 1; }
[[ -d "$PROJECT" ]] || { echo "project directory not found: $PROJECT" >&2; exit 1; }
[[ "$PROMPT" != *\"* ]] || { echo 'prompt must not contain double quotes' >&2; exit 1; }

if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI not found on PATH" >&2
  exit 1
fi

# Escape for embedding inside an AppleScript double-quoted string.
as_escape() {
  # backslash, then double-quote
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

if [[ "$(uname -s)" == "Darwin" ]] && command -v osascript >/dev/null 2>&1; then
  proj_q="$(as_escape "$PROJECT")"
  prompt_q="$(as_escape "$PROMPT")"
  osascript <<EOF
tell application "Terminal"
  do script "cd \"${proj_q}\" && claude \"${prompt_q}\""
  activate
end tell
EOF
  exit 0
fi

# Non-macOS Unix fallback: detached process, no new terminal UI.
(
  cd "$PROJECT"
  nohup claude "$PROMPT" >/dev/null 2>&1 &
)
echo "launched claude in background under $PROJECT"
