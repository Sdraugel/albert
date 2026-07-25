"""Per-session Claude Agent SDK client for the Albert concierge.

The concierge is a headless Claude Code session (it inherits the box's existing Claude Code
login; no API key handling here) whose whole tool surface is: read the run store, plus the
two custom tools in albert_tools.py. Everything write-capable is disallowed explicitly.
"""

import os
from pathlib import Path

from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

from albert_tools import SessionState, make_albert_server
from config import PROJECTS_DIR, STORE_ROOT, SYSTEM_PROMPT_PATH

# Read tools are confined to the run store. `cwd` alone is only a default for
# relative paths, not a jail: without this an injected instruction (run-store content
# is influenced by whatever the harness's subagents write) could turn the concierge
# into an arbitrary local file reader - ssh keys, .env files, other repos.
_READ_TOOLS = {"Read", "Glob", "Grep"}
# Which argument carries the path, per tool.
_PATH_KEYS = ("file_path", "path", "notebook_path")


def _within_store(raw: str) -> bool:
    try:
        target = Path(raw)
        if not target.is_absolute():
            target = STORE_ROOT / target
        # No filesystem access needed, and none wanted: a UNC path must be rejected
        # without ever being opened.
        if raw.startswith("\\\\") or raw.startswith("//"):
            return False
        resolved = Path(os.path.normpath(str(target)))
        return resolved == STORE_ROOT or STORE_ROOT in resolved.parents
    except (OSError, ValueError):
        return False


async def _gate_tool(tool_name, tool_input, context):
    """Deny read tools pointed outside the run store. Custom tools validate themselves."""
    if tool_name in _READ_TOOLS:
        for key in _PATH_KEYS:
            value = tool_input.get(key)
            if isinstance(value, str) and value and not _within_store(value):
                return {
                    "behavior": "deny",
                    "message": (
                        f"Path is outside the Albert run store ({STORE_ROOT}). The "
                        "concierge may only read run-store files."
                    ),
                }
    return {"behavior": "allow", "updatedInput": tool_input}


def load_system_prompt() -> str:
    text = SYSTEM_PROMPT_PATH.read_text(encoding="utf-8")
    return text.replace("{{STORE_ROOT}}", str(STORE_ROOT)).replace(
        "{{PROJECTS_DIR}}", str(PROJECTS_DIR)
    )


def make_client(state: SessionState) -> ClaudeSDKClient:
    options = ClaudeAgentOptions(
        system_prompt=load_system_prompt(),
        cwd=str(STORE_ROOT),
        mcp_servers={"albert": make_albert_server(state)},
        allowed_tools=[
            "Read",
            "Glob",
            "Grep",
            "mcp__albert__send_to_albert",
            "mcp__albert__start_albert_run",
        ],
        disallowed_tools=[
            "Write",
            "Edit",
            "MultiEdit",
            "NotebookEdit",
            "Bash",
            "WebSearch",
            "WebFetch",
            "Task",
            "TodoWrite",
        ],
        # Enforced in code, not just in the prompt: read tools stay inside the store.
        can_use_tool=_gate_tool,
        max_turns=30,
    )
    return ClaudeSDKClient(options=options)
