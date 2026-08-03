#!/usr/bin/env bash
# One-time setup for Albert Chat. Requires Python 3.12.
# The venv is built from 3.12 explicitly: the default python may be newer than
# Chainlit supports.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
VENV="$DIR/.venv"

pick_python() {
  if command -v python3.12 >/dev/null 2>&1; then
    echo "python3.12"
    return
  fi
  if command -v python3 >/dev/null 2>&1; then
    local ver
    ver="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
    if [[ "$ver" == "3.12" ]]; then
      echo "python3"
      return
    fi
  fi
  return 1
}

if [[ ! -x "$VENV/bin/python" ]]; then
  py="$(pick_python)" || {
    echo "Python 3.12 not found: install it (e.g. brew install python@3.12), then re-run." >&2
    exit 1
  }
  "$py" -m venv "$VENV"
fi

"$VENV/bin/python" -c 'import sys; raise SystemExit(0 if sys.version_info[:2]==(3,12) else 1)' || {
  echo "chat/.venv is not Python 3.12. Delete it and re-run setup.sh." >&2
  exit 1
}

"$VENV/bin/python" -m pip install --disable-pip-version-check -r "$DIR/requirements.txt"
echo
echo "Done. Start the chat UI with ./start.sh"
