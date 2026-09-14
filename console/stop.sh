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
elif command -v systemctl >/dev/null 2>&1 && systemctl --user stop "${UNIT_NAME}.service" 2>/dev/null; then
  # Not gated on is-active: during the Restart=always backoff after a crash the unit is
  # "activating (auto-restart)", which is-active reports as false, and skipping the stop
  # would let systemd bring the server straight back. stop on a loaded unit cancels that
  # pending restart; on a unit that is not loaded it fails and we fall through.
  echo "systemd unit ${UNIT_NAME} stopped and its auto-restart cancelled. Start again with: systemctl --user start ${UNIT_NAME}"
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
