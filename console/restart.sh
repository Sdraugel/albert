#!/usr/bin/env bash
# Restart the Albert Console (use this after changing server.mjs, lib/, or public/).
# Stop the always-on service before killing the port owner: with KeepAlive (macOS) or
# Restart=always (Linux), killing the managed PID while the service is still active
# just makes the supervisor respawn it, racing this script's own kill/restart sequence.
set -euo pipefail

LAUNCH_LABEL="com.albert.console"
UNIT_NAME="albert-console"
PORT=4400
uid="$(id -u)"
DIR="$(cd "$(dirname "$0")" && pwd)"
os="$(uname -s)"

plist="${HOME}/Library/LaunchAgents/${LAUNCH_LABEL}.plist"
supervisor=none
if [[ "$os" == "Darwin" && -f "$plist" ]]; then
  supervisor=launchd
  launchctl bootout "gui/${uid}/${LAUNCH_LABEL}" 2>/dev/null || true
elif [[ "$os" != "Darwin" ]] && command -v systemctl >/dev/null 2>&1 \
    && systemctl --user is-enabled "${UNIT_NAME}.service" >/dev/null 2>&1; then
  supervisor=systemd
  systemctl --user stop "${UNIT_NAME}.service" 2>/dev/null || true
fi

pids="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
if [[ -n "$pids" ]]; then
  echo "stopping node PID(s) $pids"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 0.5
  pids="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
else
  echo "nothing listening on $PORT"
fi

case "$supervisor" in
  launchd)
    launchctl bootstrap "gui/${uid}" "$plist"
    launchctl kickstart -k "gui/${uid}/${LAUNCH_LABEL}" 2>/dev/null || \
      launchctl start "$LAUNCH_LABEL" 2>/dev/null || true
    diagnose="launchctl print gui/${uid}/${LAUNCH_LABEL}"
    ;;
  systemd)
    systemctl --user start "${UNIT_NAME}.service"
    diagnose="systemctl --user status ${UNIT_NAME}; journalctl --user -u ${UNIT_NAME} -n 50"
    ;;
  none)
    echo "no always-on service registered; starting in background via nohup"
    nohup node "$DIR/server.mjs" >>"$DIR/console.stdout.log" 2>>"$DIR/console.stderr.log" &
    echo "started PID $! -> http://127.0.0.1:4400/"
    exit 0
    ;;
esac

sleep 2
pids="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
if [[ -n "$pids" ]]; then
  echo "restarted: node PID $pids -> http://127.0.0.1:4400/"
else
  echo "FAILED to come up. Check: $diagnose"
  echo "Logs: $DIR/console.stderr.log"
fi
