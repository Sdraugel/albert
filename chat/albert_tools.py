"""Custom tools for the Albert concierge: the only two write paths out of the chat.

Both tools shell out rather than touching the store from Python: send_to_albert goes
through _inbox.mjs (which owns the NTFS write discipline), and start_albert_run goes
through launch_run.ps1 (which owns .cmd resolution and detached-window quoting).
"""

import asyncio
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from claude_agent_sdk import create_sdk_mcp_server, tool

from config import (
    INBOX_MJS,
    LAUNCH_PS1,
    PROJECTS_DIR,
    STORE_ROOT,
    TERMINAL_STATUSES,
    read_index,
    run_entry,
)

MSG_TYPES = {"steer", "question", "info"}
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


@dataclass
class SessionState:
    """Per-chat-session state shared between the tools and app.py."""

    chat_session_id: str
    # Runs this session has messaged; app.py starts a reply watcher for each.
    sent_runs: set = field(default_factory=set)


def _text(result_text: str, is_error: bool = False) -> dict:
    out = {"content": [{"type": "text", "text": result_text}]}
    if is_error:
        out["is_error"] = True
    return out


def _run(cmd: list[str], env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=60,
        env=env,
        creationflags=NO_WINDOW,
    )


def make_albert_server(state: SessionState):
    """Build the in-process MCP server for one chat session.

    Built per session (not module level) so the tools close over the session id and its
    sent_runs set without any cross-session shared state.
    """

    @tool(
        "send_to_albert",
        "Queue a message in a run's inbox for the A.L.B.E.R.T. orchestrator. It is read at "
        "the start of the orchestrator's next wake (this can take minutes) and the reply "
        "comes back into this chat. msg_type is one of: steer (change priorities, scope, or "
        "policy; pause or stop), question (needs the orchestrator's judgment), info "
        "(context for future iterations). run_id comes from index.json; the run must not be "
        "in a terminal state.",
        {"run_id": str, "msg_type": str, "text": str},
    )
    async def send_to_albert(args):
        run_id = str(args.get("run_id", "")).strip()
        msg_type = str(args.get("msg_type", "")).strip()
        text = str(args.get("text", "")).strip()
        if msg_type not in MSG_TYPES:
            return _text(f"msg_type must be one of {sorted(MSG_TYPES)}.", is_error=True)
        if not text:
            return _text("text must be non-empty.", is_error=True)
        if not (STORE_ROOT / run_id).is_dir():
            return _text(f"run folder does not exist: {run_id}", is_error=True)

        entry = run_entry(run_id)
        status = (entry or {}).get("status")
        if status in TERMINAL_STATUSES:
            return _text(
                f"Refusing to send: run {run_id} is {status}. Nothing will ever drain its "
                "inbox. Start a new run instead, or resume this one first.",
                is_error=True,
            )

        env = {**os.environ, "ALBERT_STORE_ROOT": str(STORE_ROOT)}
        cmd = [
            "node",
            str(INBOX_MJS),
            "write",
            run_id,
            "--type",
            msg_type,
            "--text",
            text,
            "--from",
            "user",
            "--session",
            state.chat_session_id,
        ]
        try:
            proc = await asyncio.to_thread(_run, cmd, env)
        except (OSError, subprocess.TimeoutExpired) as e:
            return _text(f"could not run _inbox.mjs: {e}", is_error=True)
        if proc.returncode != 0:
            return _text(f"_inbox.mjs write failed: {proc.stderr.strip()}", is_error=True)

        state.sent_runs.add(run_id)
        message_id = proc.stdout.strip()
        note = ""
        if status == "checkpoint":
            note = (
                " Note: this run is paused at a checkpoint; the message is read when the "
                "run is resumed."
            )
        return _text(
            f"Queued {msg_type} {message_id} in {run_id}'s inbox. A.L.B.E.R.T. reads it at "
            f"the start of its next wake and the reply appears here.{note}"
        )

    @tool(
        "start_albert_run",
        "Launch a new /albert run in a project directory. Opens a separate console window "
        "that keeps running after this chat closes. project_path is absolute or relative "
        "to the projects directory. Only call this after the user confirmed the exact goal "
        "and project.",
        {"project_path": str, "goal": str},
    )
    async def start_albert_run(args):
        raw_path = str(args.get("project_path", "")).strip()
        goal = str(args.get("goal", "")).strip()
        if not raw_path or not goal:
            return _text("project_path and goal are both required.", is_error=True)

        project = Path(raw_path)
        if not project.is_absolute():
            project = PROJECTS_DIR / raw_path
        try:
            project = project.resolve(strict=True)
        except OSError:
            return _text(f"project directory not found: {raw_path}", is_error=True)
        if not project.is_dir():
            return _text(f"not a directory: {project}", is_error=True)
        try:
            project.relative_to(PROJECTS_DIR.resolve())
        except ValueError:
            return _text(
                f"project must be under {PROJECTS_DIR}, got: {project}", is_error=True
            )

        index = read_index() or {}
        active = index.get("active_run_id")
        active_entry = run_entry(active) if active else None
        if active_entry and active_entry.get("status") == "running":
            return _text(
                f"Refusing to launch: run {active} is already running. One active run at a "
                "time; steer or stop it first via send_to_albert.",
                is_error=True,
            )

        # launch_run.ps1 rejects double quotes outright, so strip them here along with
        # newlines; the goal must travel as one clean argument.
        goal = re.sub(r"\s+", " ", goal).replace('"', "'").strip()
        prompt = f"/loop /albert {goal}"
        cmd = [
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(LAUNCH_PS1),
            "-Project",
            str(project),
            "-Prompt",
            prompt,
        ]
        try:
            proc = await asyncio.to_thread(_run, cmd)
        except (OSError, subprocess.TimeoutExpired) as e:
            return _text(f"could not launch the run: {e}", is_error=True)
        if proc.returncode != 0:
            return _text(f"launch failed: {proc.stderr.strip()}", is_error=True)

        return _text(
            f"Launched /albert in a new console window for {project.name} with goal: "
            f"{goal}. It registers itself in the run store shortly; watch it live at "
            "http://127.0.0.1:4400."
        )

    return create_sdk_mcp_server(
        name="albert",
        version="1.0.0",
        tools=[send_to_albert, start_albert_run],
    )
