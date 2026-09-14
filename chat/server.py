"""Albert Chat entrypoint: Chainlit behind an Origin guard.

WHY THIS FILE EXISTS (do not "simplify" it back to `chainlit run app.py`):

Chainlit's `allow_origins` setting only reaches Starlette's HTTP CORS middleware.
The Socket.IO transport that carries the actual chat traffic validates nothing:
`chainlit/server.py` constructs the server with `cors_allowed_origins=[]`, and
`engineio/async_server.py` skips its Origin check entirely when that list is empty.
Browsers do not apply CORS to WebSocket, so with `chainlit run` ANY page you happen
to be browsing can open `ws://127.0.0.1:4401/ws/socket.io/`, drive a full concierge
session, and read the replies (cross-site WebSocket hijacking). Verified against
this install: a handshake carrying `Origin: https://evil.example` was answered with
a session id.

That matters more here than in a stock Chainlit app, because this concierge can
queue steering messages and launch `/albert` runs, so a drive-by page would reach
agentic code execution on the machine.

The guard below runs as pure ASGI in front of everything, so it sees `websocket`
scopes as well as `http` ones, and rejects any request whose Origin is not this
service's own. Requests with no Origin header (curl, the local browser's top-level
navigation) are allowed: browsers always send Origin on the cross-origin paths that
matter here (WebSocket handshakes and fetch/XHR).

Run with:  uvicorn server:app --host 127.0.0.1 --port 4401
"""

import os

from fastapi import FastAPI
from chainlit.utils import mount_chainlit

HOST = os.environ.get("ALBERT_CHAT_HOST", "127.0.0.1")
PORT = os.environ.get("ALBERT_CHAT_PORT", "4401")

# Only this service's own origins. The console embeds the chat in an iframe, and an
# iframe's requests carry the IFRAME's origin (this service), not the console's, so
# the console's port does not belong here.
#
# ALBERT_CHAT_ORIGINS (comma-separated) adds the origins this service answers on when it
# is fronted by a reverse proxy. On a headless Linux box the browser is never on
# localhost, so the iframe's origin is the proxy's (e.g. a Tailscale Serve HTTPS origin
# on this same port) and the localhost entries below never match. This still names exact
# origins, so a drive-by page is rejected exactly as before.
ALLOWED_ORIGINS = frozenset(
    {
        f"http://127.0.0.1:{PORT}",
        f"http://localhost:{PORT}",
        f"http://[::1]:{PORT}",
    }
    | {o.strip() for o in os.environ.get("ALBERT_CHAT_ORIGINS", "").split(",") if o.strip()}
)


class OriginGuard:
    """Reject http/websocket scopes carrying a foreign Origin header."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            origin = None
            for name, value in scope.get("headers") or []:
                if name == b"origin":
                    origin = value.decode("latin-1")
                    break
            if origin is not None and origin not in ALLOWED_ORIGINS:
                if scope["type"] == "websocket":
                    # Refuse the handshake outright.
                    await send({"type": "websocket.close", "code": 1008})
                    return
                await send(
                    {
                        "type": "http.response.start",
                        "status": 403,
                        "headers": [(b"content-type", b"text/plain; charset=utf-8")],
                    }
                )
                await send({"type": "http.response.body", "body": b"forbidden origin\n"})
                return
        await self.app(scope, receive, send)


app = FastAPI()
mount_chainlit(app=app, target=os.path.join(os.path.dirname(__file__), "app.py"), path="")
app = OriginGuard(app)
