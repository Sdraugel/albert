#!/usr/bin/env bash
# Stop the Albert Console for good: unload the LaunchAgent first (so KeepAlive cannot
# revive it), then kill whatever still owns port 4400.
set -euo pipefail

LAUNCH_LABEL="com.albert.console"
PORT=4400
uid="$(id -u)"

if launchctl print "gui/${uid}/${LAUNCH_LABEL}" >/dev/null 2>&1; then
  launchctl bootout "gui/${uid}/${LAUNCH_LABEL}" 2>/dev/null || true
  echo "LaunchAgent ${LAUNCH_LABEL} unloaded. Re-enable with: launchctl bootstrap gui/${uid} ~/Library/LaunchAgents/${LAUNCH_LABEL}.plist"
elif [[ -f "${HOME}/Library/LaunchAgents/${LAUNCH_LABEL}.plist" ]]; then
  launchctl unload "${HOME}/Library/LaunchAgents/${LAUNCH_LABEL}.plist" 2>/dev/null || true
  echo "LaunchAgent ${LAUNCH_LABEL} unloaded"
fi

pids="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
if [[ -n "$pids" ]]; then
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 0.3
  pids="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
  echo "server stopped"
else
  echo "server was not running"
fi
