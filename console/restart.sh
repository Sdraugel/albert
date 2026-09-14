#!/usr/bin/env bash
# Restart the Albert Console (use this after changing server.mjs, lib/, or public/).
# Unloads KeepAlive briefly is unnecessary if we kickstart -k; kill the port owner
# first so the next bind succeeds, then restart the LaunchAgent (or start.sh fallback).
set -euo pipefail

LAUNCH_LABEL="com.albert.console"
PORT=4400
uid="$(id -u)"
DIR="$(cd "$(dirname "$0")" && pwd)"

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

sleep 1

plist="${HOME}/Library/LaunchAgents/${LAUNCH_LABEL}.plist"
if [[ -f "$plist" ]]; then
  launchctl bootout "gui/${uid}/${LAUNCH_LABEL}" 2>/dev/null || true
  launchctl bootstrap "gui/${uid}" "$plist"
  launchctl kickstart -k "gui/${uid}/${LAUNCH_LABEL}" 2>/dev/null || \
    launchctl start "$LAUNCH_LABEL" 2>/dev/null || true
  sleep 2
  pids="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "restarted: node PID $pids -> http://127.0.0.1:4400/"
  else
    echo "FAILED to come up. Check: launchctl print gui/${uid}/${LAUNCH_LABEL}"
    echo "Logs: $DIR/console.stderr.log"
  fi
else
  echo "no LaunchAgent registered; starting in background via nohup"
  nohup node "$DIR/server.mjs" >>"$DIR/console.stdout.log" 2>>"$DIR/console.stderr.log" &
  echo "started PID $! -> http://127.0.0.1:4400/"
fi
