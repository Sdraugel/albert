# Albert run store

Durable state for the `/albert` long-running harness. Global on purpose: it lives here, not
inside any project, so it can never be committed into a repo's history. Work product from a run is
committed into that project's own git repo; only the bookkeeping below is global.

## Layout

- `index.json` - the registry: `active_run_id` and one entry per run (`id`, `project_path`, `status`).
- `<run-id>/` - one folder per run (`<project>-<slug>-<YYYY-MM-DD>`):
  - `goal.md` - the goal, acceptance criteria, profile, budget, and `allow_deploy` flag.
  - `project.json` - auto-detected project facts (path, git root, stack, verify commands, docs convention).
  - `tasks.json` - the granular, independently-verifiable task list. `passes:true` only with evidence.
  - `progress.json` - iteration, budget spent, best-so-far, blockers, status. The resume anchor.
  - `init.ps1` - idempotent environment bootstrap for this project.
  - `ledger.csv` - research trial ledger (append-only).
  - `events.jsonl` - append-only activity stream, one JSON event per line, written via `_emit.mjs`; the Albert Console tails it.
  - `iterations/<n>/` - per-iteration verdict.json plus captured verify stdout and exit codes.

## Using it

- Supervised: `/albert "<goal>" [--project <path>]`
- Unattended: `/loop /albert "<goal>"` (self-paced; stops and notifies at a terminal state)
- Resume after a pause or context reset: `/albert --resume <run-id>`

Deploys and other irreversible actions stay gated: they only auto-execute when `goal.md` sets
`allow_deploy: true`, otherwise the loop stages the change and stops for approval.

Do not hand-edit a run's state while its loop is active.

## Event stream

Append an event to a run's `events.jsonl` (and optionally sync its status in `index.json` and
`progress.json` in one shot):

```
node _emit.mjs <run-id> <type> <actor> <target> <summary> [jsonData] [--task <id>] [--iter <n>] [--chunk <id>] [--status <status>]
```

### Shell quoting for `jsonData`

`jsonData` must reach node as literal JSON, quotes included. What to type depends on the calling
shell (all forms below verified on this box, Node v26):

- **Git Bash**: wrap it in single quotes.

  ```bash
  node _emit.mjs my-run-2026-07-15 test.ping chief store "ping" '{"k":1}'
  ```

- **PowerShell 5.1** (this box's primary shell): plain quoting does NOT work. Native argument
  passing strips the inner double quotes, so `'{"k":1}'` arrives as `{k:1}` and fails with
  `jsonData is not valid JSON`, and unquoted JSON containing spaces splits into extra positionals.
  `"{\"k\":1}"` also fails (PowerShell splits it into several arguments). Working forms:

  JSON with no whitespace inside it: backslash-escape every inner quote inside a single-quoted
  string. This breaks again the moment the JSON contains a space (PowerShell then re-escapes the
  embedded quotes while wrapping the argument), so keep it whitespace-free or use `--%` below.

  ```powershell
  node _emit.mjs my-run-2026-07-15 test.ping chief store "ping" '{\"k\":1}'
  ```

  Any JSON, including values with spaces: the stop-parsing token `--%`. Everything after it is
  passed verbatim to node for the rest of the line, so no PowerShell variables after it and
  nothing else on the line:

  ```powershell
  node --% _emit.mjs my-run-2026-07-15 test.ping chief store "ping" "{\"msg\":\"two words\"}"
  ```

Other arguments containing spaces (typically `<summary>`) only need normal quoting in either shell.
