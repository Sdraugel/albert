#!/usr/bin/env bash
# One-time setup for Albert Chat. Requires Python 3.12.
# The venv is built from 3.12 explicitly: the default python may be newer than
# Chainlit supports. Without a system 3.12, uv can download one (uv venv --python 3.12).
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
  if py="$(pick_python)"; then
    "$py" -m venv "$VENV"
  elif command -v uv >/dev/null 2>&1; then
    uv venv --python 3.12 "$VENV"
  else
    echo "Python 3.12 not found. Install it (macOS: brew install python@3.12; Linux: your distro's python3.12 package) or install uv (https://docs.astral.sh/uv/), which downloads one, then re-run." >&2
    exit 1
  fi
fi

"$VENV/bin/python" -c 'import sys; raise SystemExit(0 if sys.version_info[:2]==(3,12) else 1)' || {
  echo "chat/.venv is not Python 3.12. Delete it and re-run setup.sh." >&2
  exit 1
}

# A venv created by uv has no pip; install through uv in that case.
if "$VENV/bin/python" -m pip --version >/dev/null 2>&1; then
  "$VENV/bin/python" -m pip install --disable-pip-version-check -r "$DIR/requirements.txt"
else
  uv pip install --python "$VENV/bin/python" -r "$DIR/requirements.txt"
fi
echo
echo "Done. Start the chat UI with ./start.sh"
