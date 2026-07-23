"""Poll a run's events.jsonl for chat.reply events addressed to this chat session.

Read-only and session-scoped: one watcher task per (session, run). The offset starts at
end-of-file so old replies never replay, and only new complete lines are parsed; a partial
trailing line is kept in memory and finished on a later tick. Transient open errors are
normal (the store is contended on this box) and simply skip the tick.
"""

import asyncio
import json
from pathlib import Path

POLL_SECONDS = 2.5


async def watch_replies(events_path: Path, chat_session_id: str, on_reply):
    try:
        offset = events_path.stat().st_size
    except OSError:
        offset = 0
    partial = b""

    while True:
        await asyncio.sleep(POLL_SECONDS)
        try:
            size = events_path.stat().st_size
        except OSError:
            continue
        if size < offset:
            # The file was replaced or truncated; re-read whatever is there now.
            offset = 0
            partial = b""
        if size == offset:
            continue
        try:
            with events_path.open("rb") as f:
                f.seek(offset)
                chunk = f.read()
        except OSError:
            continue
        offset += len(chunk)

        lines = (partial + chunk).split(b"\n")
        partial = lines.pop()
        for raw in lines:
            raw = raw.strip()
            if not raw:
                continue
            try:
                event = json.loads(raw.decode("utf-8", errors="replace"))
            except ValueError:
                continue
            if event.get("type") != "chat.reply":
                continue
            data = event.get("data") or {}
            if data.get("chat_session") != chat_session_id:
                continue
            text = data.get("text") or event.get("summary") or ""
            if text:
                await on_reply(text)
