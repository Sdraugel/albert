#!/usr/bin/env bash
# Start the Albert Console in the foreground and open the browser.
# Closing this terminal stops the server (use the LaunchAgent for always-on).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
if command -v open >/dev/null 2>&1; then
  (sleep 1; open "http://127.0.0.1:4400/") &
elif command -v xdg-open >/dev/null 2>&1; then
  (sleep 1; xdg-open "http://127.0.0.1:4400/") &
fi
exec node "$DIR/server.mjs" "$@"
