"""Shared paths and store helpers for Albert Chat.

Env overrides (all optional, mainly for tests against demo data):
  ALBERT_STORE_ROOT    run store root (default: %USERPROFILE%\\.claude\\agent-runs)
  ALBERT_PROJECTS_DIR  where start_albert_run may launch runs (default: parent of this repo,
                       matching install.ps1's ProjectsDir default)
  ALBERT_INBOX_MJS     path to _inbox.mjs (default: the installed copy in the store dir,
                       falling back to the repo copy)
"""

import json
import os
from pathlib import Path

CHAT_DIR = Path(__file__).resolve().parent
REPO_ROOT = CHAT_DIR.parent

CLAUDE_DIR = Path.home() / ".claude"
STORE_ROOT = Path(os.environ.get("ALBERT_STORE_ROOT") or CLAUDE_DIR / "agent-runs")
PROJECTS_DIR = Path(os.environ.get("ALBERT_PROJECTS_DIR") or REPO_ROOT.parent)

INBOX_MJS = Path(os.environ.get("ALBERT_INBOX_MJS") or CLAUDE_DIR / "agent-runs" / "_inbox.mjs")
if not INBOX_MJS.exists():
    _repo_copy = REPO_ROOT / "harness" / "runtime" / "_inbox.mjs"
    if _repo_copy.exists():
        INBOX_MJS = _repo_copy

LAUNCH_PS1 = CHAT_DIR / "launch_run.ps1"
SYSTEM_PROMPT_PATH = CHAT_DIR / "system_prompt.md"

# A message sent to a run in one of these states would sit in the inbox forever:
# nothing will ever wake up to drain it.
TERMINAL_STATUSES = {"done", "stopped", "budget_exhausted", "converged", "stuck", "failed"}


def read_index():
    """Parse index.json; None if missing or unreadable. utf-8-sig tolerates BOM writers."""
    try:
        return json.loads((STORE_ROOT / "index.json").read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None


def run_entry(run_id):
    """The registry entry for run_id, or None if unregistered."""
    index = read_index() or {}
    for entry in index.get("runs") or []:
        if isinstance(entry, dict) and entry.get("id") == run_id:
            return entry
    return None
