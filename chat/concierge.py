"""Per-session Claude Agent SDK client for the Albert concierge.

The concierge is a headless Claude Code session (it inherits the box's existing Claude Code
login; no API key handling here) whose whole tool surface is: read the run store, plus the
two custom tools in albert_tools.py. Everything write-capable is disallowed explicitly.
"""

from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

from albert_tools import SessionState, make_albert_server
from config import PROJECTS_DIR, STORE_ROOT, SYSTEM_PROMPT_PATH


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
        max_turns=30,
    )
    return ClaudeSDKClient(options=options)
