# Albert Chat

A Chainlit chat UI for the Albert harness. It gives you a conversation with two layers:

- **The concierge answers in seconds.** Each chat session runs a headless Claude Code
  session (via the Claude Agent SDK) restricted to read-only tools over the run store, so it
  can answer "what is the active run doing?", "which tasks failed?", "how much budget is
  left?" from live data.
- **A.L.B.E.R.T. answers on its next wake.** Steering messages ("prioritize X", "stop after
  this chunk") queue in the run's `inbox/` via `_inbox.mjs`. The orchestrator drains the
  inbox at the top of every wake (LOOP step 0 of the `/albert` skill), acts on it, and its
  `chat.reply` lands back in this chat and in the console Comms feed. Expect minutes, not
  seconds.

It can also **start new runs**: the concierge launches `/loop /albert "<goal>"` in a separate
console window for a project you name. That window is the live orchestrator session and
survives closing the chat.

## Prerequisites

- Windows, with the Albert harness installed (`install.ps1` from the repo root; it deploys
  `_inbox.mjs` into the run store).
- **Python 3.12** available as `py -3.12` (the default `python` may be newer than Chainlit
  supports; setup builds the venv from 3.12 explicitly).
- Node on PATH (the harness already requires it).
- Claude Code installed and logged in. The concierge inherits that login; no API key is
  needed or read.

## Setup and run

```
setup.cmd      # one-time: creates .venv from Python 3.12 and installs requirements
start.cmd      # serves http://127.0.0.1:4401 and opens the browser (foreground)
stop.cmd       # kills whatever owns port 4401
```

`start.cmd` runs in the foreground: closing that window stops the chat. For an always-on
chat (so the console's CHAT dock is always live), point an HKCU Run entry at
`run-forever.vbs`, which starts the server hidden at logon and relaunches it within
seconds if it dies:

```powershell
Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name AlbertChat `
  -Value 'wscript.exe "<repo>\chat\run-forever.vbs"'
```

`stop.cmd` kills the supervisor and the server together (a plain port kill is not enough;
the supervisor would relaunch it).

Resolved versions this was built and tested against: Python 3.12.6, chainlit 2.11.1,
claude-agent-sdk 0.2.126.

## Ports

- Chat UI: `127.0.0.1:4401`
- Albert Console: `127.0.0.1:4400` (unchanged, read-only; chat traffic shows up in its Comms
  feed as `CHAT.MSG` / `CHAT.REPLY` rows)

## Configuration (env vars, all optional)

- `ALBERT_STORE_ROOT` - run store root (default `%USERPROFILE%\.claude\agent-runs`). Point it
  at demo data (`node tools\make-demo-data.mjs <out>` then `<out>\agent-runs`) to try the UI
  without real runs.
- `ALBERT_PROJECTS_DIR` - where `start_albert_run` may launch runs (default: the parent
  directory of this repo, same as the installer's default).
- `ALBERT_INBOX_MJS` - path to `_inbox.mjs` (default: the installed copy in the store;
  falls back to the repo copy).

## Caveats

- **Replies from the orchestrator are not instant.** They arrive when the run next wakes.
  If no run is active, only the concierge answers.
- **Launched runs still obey your permission setup.** An unattended `/loop /albert` run needs
  the harness tool patterns pre-approved in your Claude Code settings (see the `/albert`
  skill prerequisites); otherwise the new window sits at its first permission prompt until
  you answer it there.
- **One active run at a time.** `start_albert_run` refuses while the registry shows a
  running run; steer or stop it first.
- Messages sent to a run that reaches a terminal state before its next wake are never
  drained; the concierge refuses sends to already-terminal runs for the same reason.
