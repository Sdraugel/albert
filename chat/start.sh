#!/usr/bin/env bash
# Albert Chat on http://127.0.0.1:4401. Runs in the foreground: closing this
# terminal stops it.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
[[ -x "$DIR/.venv/bin/python" ]] || { echo "Run ./setup.sh first." >&2; exit 1; }

if command -v open >/dev/null 2>&1; then
  (sleep 2; open "http://127.0.0.1:4401/") &
elif command -v xdg-open >/dev/null 2>&1; then
  (sleep 2; xdg-open "http://127.0.0.1:4401/") &
fi

# Served through server.py, NOT `chainlit run`: it adds the Origin guard that stops
# any page you happen to be browsing from hijacking the chat's WebSocket.
cd "$DIR"
exec "$DIR/.venv/bin/python" -m uvicorn server:app --host 127.0.0.1 --port 4401 "$@"
