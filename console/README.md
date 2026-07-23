# Albert Console

A live, Jarvis-style console for the `/albert` harness. It watches the global run store at `%USERPROFILE%\.claude\agent-runs\` and monitors ALL projects' runs from one place. Zero npm dependencies (Node builtins only), binds to 127.0.0.1 only.

**Strictly read-only over the store.** The server never writes to the run store; it only reads and streams what the harness itself produces.

## Run

- Double-click `start.cmd` (starts the server and opens the browser), or
- `node server.mjs` from this directory.

Note that `start.cmd` runs the server in the foreground: closing that console window stops it. For
an always-on instance use the Scheduled Task below.

## Always on (AlbertConsole Scheduled Task)

A Scheduled Task named `AlbertConsole` keeps the server up permanently at
`http://127.0.0.1:4400`. It runs `run-hidden.vbs`, which launches node with no console window.

How it stays alive: the task has two triggers. One starts it at logon. The other is a 1-minute
watchdog repetition; with `MultipleInstancesPolicy = IgnoreNew`, each tick is a no-op while the
server is alive and a revival when it is not, so a crash self-heals within about a minute.
`ExecutionTimeLimit` is `PT0S` (no limit), otherwise the 3-day default would kill it.

The launcher waits on node and propagates its exit code rather than spawning and exiting. That
keeps the task in the `Running` state for as long as the server lives, which is what makes the
watchdog's IgnoreNew check meaningful. Do not "simplify" it back to a fire-and-forget launch.

### Restarting and stopping (read this before using Stop-ScheduledTask)

`Stop-ScheduledTask` does NOT stop the server, and this trips people up. The task's action is
`wscript`, which waits on a `node` child. Stopping the task kills only `wscript`; node survives as
an orphan still holding port 4400. The next start then cannot bind, so the OLD code keeps serving
and edits appear to do nothing. Use the scripts instead, which kill the port owner directly:

```
restart.cmd    # after changing server.mjs, lib/ or public/: kills the port owner, starts a fresh one
stop.cmd       # disables the watchdog first, then kills the port owner (both steps are required)
```

Manual equivalents and inspection:

```powershell
Start-ScheduledTask -TaskName AlbertConsole      # start now, without waiting for a logon
Get-ScheduledTaskInfo -TaskName AlbertConsole    # LastRunTime / LastTaskResult / NextRunTime
Get-NetTCPConnection -LocalPort 4400 -State Listen   # confirm it is serving, and which PID
Enable-ScheduledTask -TaskName AlbertConsole     # undo stop.cmd
Unregister-ScheduledTask -TaskName AlbertConsole -Confirm:$false   # remove entirely
```

Killing the node process alone is not enough to stop it for good: the watchdog revives it within
about a minute. Disable the task first, which is what `stop.cmd` does.

## Flags

| Flag | Default | Meaning |
|------|---------|---------|
| `--port N` | `4400` | HTTP listen port on 127.0.0.1 |
| `--store <path>` | `%USERPROFILE%\.claude\agent-runs` | Run store root |
| `--agents <path>` | `%USERPROFILE%\.claude\agents` | Agent definitions dir (`loop-*.md`) |

## Views

1. **Fleet** - A.L.B.E.R.T. (the orchestrator) plus every `loop-*` agent, with class, role, model and
   heartbeat. An **AMBIENT** section lists agent types seen in ad-hoc Claude Code sessions
   (general-purpose, Explore, code-reviewer, ...) which are deliberately kept out of the Graph.
2. **Comms** - live feed of harness events and session events.
3. **Graph** - the harness orchestration screen: A.L.B.E.R.T. at the reactor core, `loop-*` agents as
   hex nodes, connectors flowing gold on activity.
4. **Sessions** - two groups: **harness runs** (goal, tasks, progress notes, ledger, per-iteration
   logs) and **Claude Code sessions** (every session in every project, with a DELEGATION panel).

## Claude Code session tracking

The console tails Claude Code's own transcripts under `%USERPROFILE%\.claude\projects\` (no hooks,
no config, zero added latency, and retroactive over existing sessions). It backfills at boot then
tails from stored byte offsets.

**Privacy is structural.** `lib/transcript-adapter.mjs` is the only module that knows the transcript
schema, and it builds every record from named fields on an allowlist. Prompts, message content, tool
inputs and tool output can never reach the API or the UI. Do not "simplify" it by spreading a parsed
transcript object.

Transcripts are an internal, undocumented format that has already drifted once (the dispatch tool was
renamed `Task` -> `Agent`), and Claude Code prunes the directory on its own schedule. So: keep all
schema knowledge in the adapter, accept both names, and treat the feed as ephemeral, not as history.

**DELEGATION panel**: per session it compares main-context tool use against dispatches, to show
whether the routing policy in your global CLAUDE.md is actually being followed. It reports, it does
not enforce: nothing in Claude Code can force delegation. The `tests` signal is a coarse proxy (it
counts Bash calls by tool name, not what they ran).

## API

- `GET /api/roster`, `GET /api/runs`, `GET /api/runs/:id`, `GET /api/runs/:id/logs/:n/:file`
- `GET /api/sessions`, `GET /api/sessions/:id`
- `GET /events` - Server-Sent Events: `init` snapshot, then `harness`/`state` (run store) and
  `session`/`session-state` (Claude Code sessions), with heartbeats.
