# Security

## What this software does

Three independent pieces ship in this repo:

- **The Albert harness** installs into your Claude Code config (`~/.claude`) and runs
  autonomous agents that read and write files in your projects, run shell commands, open
  pull requests, and (if you opt in) merge them.
- **The Albert Console** is a local, read-only web dashboard that monitors those runs.
- **Albert Chat** (optional, not installed by default) is a local Chainlit service that
  lets you question and steer the orchestrator. Unlike the console it can write, though
  only in two narrow ways: queueing a message into a run's inbox, and launching a new
  `/albert` run. See "Albert Chat can write" below.

All three are meant to run on your own machine, against your own projects. Read this
before an unattended run.

## The console is local and read-only

- It binds to `127.0.0.1` only. It is never exposed on a public interface. Do not put it
  behind a public reverse proxy; it has no authentication because it assumes a single local
  user.
- It opens files read-only under your `~/.claude` (the run store and Claude Code
  transcripts) and never writes to them.
- The transcript reader (`console/lib/transcript-adapter.mjs`) is the single schema
  boundary. It emits only an allowlist of structured metadata (agent types, counts,
  timings, token totals, run titles). It never forwards prompt text or response bodies to
  the browser. Keep it that way (see CONTRIBUTING.md).
- Subagent attribution reads only the small `agent-*.meta.json` sidecars next to each
  subagent transcript, through the same adapter. The subagent transcripts themselves are
  never opened.

## Albert Chat can write (the console still cannot)

Albert Chat is opt-in: nothing runs until you create its venv and start it yourself. When
you do:

- It binds `127.0.0.1:4401`, has no authentication, and assumes a single local user, same
  posture as the console. The console embeds it in an iframe; both stay loopback-only.
- Its concierge is a headless Claude Code session restricted to read-only tools over the
  run store, plus exactly two write paths: `send_to_albert` (queue an inbox message for a
  run) and `start_albert_run` (launch `/albert` in a project directory). Both validate
  their inputs in code, not just in the prompt: the run must exist and must not be in a
  terminal state, and the project must be an existing directory under your projects dir.
- Everything it writes goes to the run store on disk through `harness/runtime/_inbox.mjs`.
  The console server is not a write path and gains no endpoints.
- Inbox messages are advisory. The orchestrator folds a steer into its next wake and may
  re-prioritize or re-scope, but a steer can never weaken a gate, delete a task, or
  reverse a verifier or QA rejection.
- Treat the chat as trusted local input. Anyone who can reach port 4401 can queue steering
  messages and start runs, which is the same trust level as being able to run `/albert`
  yourself.

## Credentials

- The harness itself uses whatever Claude Code credentials you already have. This repo
  ships none, and the installer copies none.
- Albert Chat likewise stores no credentials: its concierge inherits your existing Claude
  Code login through the Claude Agent SDK. It neither reads nor requires an API key, and
  no key is written to its config.
- The console holds no credentials by default. The optional plan-usage strip shells out to
  your local `claude` CLI (`claude auth status --json`) for the plan tier only; it reads no
  token and stores nothing.
- If you create a `albert-console.local.json` to enable the (fragile, undocumented) usage
  endpoint, that file is git-ignored, is read only on the server side, and its contents are
  never logged or returned to the browser. Treat anything you put in it as a full-account
  credential and rotate it if it is ever exposed.

## The harness can change your code and merge PRs

- Autonomous agents edit files and run commands. Run them on a repo you can reset (a clean
  git tree), and review the run's `goal.md` policy before starting.
- Merging is off unless you both add a `gh pr merge` permission rule to your Claude Code
  settings and set `merge_policy: auto_on_signoff`. Only do that if you want hands-free
  merging after code-review and QA sign-off.
- Deploys, migrations, and other irreversible steps stay gated behind `allow_deploy: true`
  in `goal.md`. Leave it off unless you mean it.

## Known fragility (not a vulnerability, but know it)

The console reads Claude Code's transcript format and an optional undocumented usage
endpoint. Both are internal to Claude Code and can change without notice. A change degrades
one view (isolated behind its adapter) rather than breaking the whole tool, and never
causes it to leak more than the allowlist.

## Reporting a vulnerability

Please report privately via this repository's GitHub Security Advisories ("Report a
vulnerability"), not a public issue. Include what you ran and what you observed.
