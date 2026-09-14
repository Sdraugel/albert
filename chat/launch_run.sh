#!/usr/bin/env bash
# Launch a detached, visible Claude Code session running an /albert goal.
#
# Invoked by the chat backend as:
#   bash launch_run.sh --project <dir> --prompt <text>
#
# On macOS this opens a new Terminal.app window (mirrors Windows Start-Process).
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

if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI not found on PATH" >&2
  exit 1
fi

# Escape for an AppleScript double-quoted string literal. Only the temp script path
# goes through here; user data never touches the AppleScript source. sed rather than
# bash pattern substitution because macOS's stock bash 3.2 does not double a
# backslash with "${s//\\/\\\\}" the way bash 4.3+ does.
as_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

if [[ "$(uname -s)" == "Darwin" ]] && command -v osascript >/dev/null 2>&1; then
  # Terminal's "do script" hands its text to the user's login shell (zsh on modern
  # macOS) to re-parse, so the project and prompt are never embedded in it. They go
  # into a throwaway bash script, printf %q-quoted for bash to read back, and the
  # only thing Terminal sees is "bash <that path>". The script deletes itself.
  claude_bin="$(command -v claude)"
  tmp="$(mktemp "${TMPDIR:-/tmp}/albert-launch.XXXXXX")"
  printf '#!/bin/bash\nrm -f -- "$0"\ncd %q && exec %q %q\n' "$PROJECT" "$claude_bin" "$PROMPT" > "$tmp"
  cmd_q="$(as_escape "bash $(printf '%q' "$tmp")")"
  osascript <<EOF || { rm -f "$tmp"; exit 1; }
tell application "Terminal"
  do script "${cmd_q}"
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
