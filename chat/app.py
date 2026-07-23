"""Albert Chat: Chainlit front end for the Albert harness.

One concierge session (a headless Claude Code session via the Agent SDK) per chat session.
User text goes to the concierge; assistant text streams back. When the concierge queues a
message for a run, a per-run watcher tails that run's events.jsonl and posts A.L.B.E.R.T.'s
chat.reply events into the conversation as they land.
"""

import asyncio

import chainlit as cl
from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock

from albert_tools import SessionState
from concierge import make_client
from config import STORE_ROOT
from reply_watcher import watch_replies


@cl.on_chat_start
async def on_chat_start():
    state = SessionState(chat_session_id=cl.user_session.get("id") or "chat")
    client = make_client(state)
    await client.connect()
    cl.user_session.set("state", state)
    cl.user_session.set("client", client)
    cl.user_session.set("watchers", {})


@cl.on_message
async def on_message(message: cl.Message):
    client = cl.user_session.get("client")
    state = cl.user_session.get("state")
    watchers = cl.user_session.get("watchers")
    if client is None or state is None:
        await cl.Message(content="Session not initialized; reload the page.").send()
        return

    reply = cl.Message(content="")
    streamed = False
    final = None
    try:
        await client.query(message.content)
        async for msg in client.receive_response():
            if isinstance(msg, AssistantMessage):
                for block in msg.content:
                    if isinstance(block, TextBlock) and block.text:
                        if streamed:
                            await reply.stream_token("\n\n")
                        await reply.stream_token(block.text)
                        streamed = True
            elif isinstance(msg, ResultMessage):
                final = getattr(msg, "result", None)
    except Exception as e:  # surface, never crash the session
        await cl.Message(content=f"Concierge error: {e}").send()
        return

    if streamed:
        await reply.send()
    elif final:
        await cl.Message(content=str(final)).send()

    # Start a reply watcher for any run this session messaged for the first time. Created
    # here, inside the session handler, so Chainlit's session context is inherited.
    for run_id in sorted(state.sent_runs):
        if run_id in watchers:
            continue
        events_path = STORE_ROOT / run_id / "events.jsonl"

        async def deliver(text: str):
            await cl.Message(content=text, author="A.L.B.E.R.T.").send()

        watchers[run_id] = asyncio.create_task(
            watch_replies(events_path, state.chat_session_id, deliver)
        )


@cl.on_stop
async def on_stop():
    client = cl.user_session.get("client")
    if client is not None:
        try:
            await client.interrupt()
        except Exception:
            pass


@cl.on_chat_end
async def on_chat_end():
    for task in (cl.user_session.get("watchers") or {}).values():
        task.cancel()
    client = cl.user_session.get("client")
    if client is not None:
        try:
            await client.disconnect()
        except Exception:
            pass
