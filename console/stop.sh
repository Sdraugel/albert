#!/usr/bin/env bash
# Stop the Albert Console for good: unload the always-on service first (so KeepAlive on
# macOS or Restart=always on Linux cannot revive it), then kill whatever still owns 4400.
set -euo pipefail

LAUNCH_LABEL="com.albert.console"
UNIT_NAME="albert-console"
PORT=4400
uid="$(id -u)"

if [[ "$(uname -s)" == "Darwin" ]]; then
  if launchctl print "gui/${uid}/${LAUNCH_LABEL}" >/dev/null 2>&1; then
    launchctl bootout "gui/${uid}/${LAUNCH_LABEL}" 2>/dev/null || true
    echo "LaunchAgent ${LAUNCH_LABEL} unloaded. Re-enable with: launchctl bootstrap gui/${uid} ~/Library/LaunchAgents/${LAUNCH_LABEL}.plist"
  elif [[ -f "${HOME}/Library/LaunchAgents/${LAUNCH_LABEL}.plist" ]]; then
    launchctl unload "${HOME}/Library/LaunchAgents/${LAUNCH_LABEL}.plist" 2>/dev/null || true
    echo "LaunchAgent ${LAUNCH_LABEL} unloaded"
  fi
elif command -v systemctl >/dev/null 2>&1 && systemctl --user is-active "${UNIT_NAME}.service" >/dev/null 2>&1; then
  systemctl --user stop "${UNIT_NAME}.service"
  echo "systemd unit ${UNIT_NAME} stopped. Start again with: systemctl --user start ${UNIT_NAME}"
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
