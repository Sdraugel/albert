# Contributing

Thanks for your interest. A few ground rules keep this project simple, private, and safe.

## Hard constraints

- **Zero runtime dependencies.** The console, the emit helper, and the parallel executor
  use only Node builtins (`node:*`). There is no `package.json` and no `npm install`. A PR
  that adds a dependency will be declined; find a builtin way or leave it out.
- **The privacy allowlist is sacrosanct.** `console/lib/transcript-adapter.mjs` emits only
  named, allowlisted metadata fields, never raw prompt or response text. Do not add a code
  path that reads transcript content outside that adapter, or that forwards a message body
  to the client. This is the whole reason the console is safe to run.
- **Windows-first.** The launchers (`.cmd`, `.vbs`), the always-on Scheduled Task, and the
  installer target Windows and PowerShell 5.1. Keep them working. Cross-platform support is
  welcome as long as it does not break the Windows path.
- **House style.** Match the terse voice of the existing agents and code. No em or en
  dashes in prose or comments; use commas, periods, or hyphens. Comments explain WHY, not
  WHAT.

## Before you open a PR

- Run `node --check` on every `.mjs` / `.js` file you touched.
- If you changed the console, run it (`console\restart.cmd`) and confirm the affected view
  still renders in the browser.
- If you changed an agent, the skill, or a template token, run
  `install.ps1 -ClaudeDir <scratch> -NoConsole` into a throwaway folder and confirm every
  `{{TOKEN}}` resolved and nothing personal leaked in.
- Never commit a `*.local.json`, a `.credentials.json`, an `.env`, or any real path from
  your own machine. `.gitignore` guards the common cases; you are still responsible.

## Reporting bugs and ideas

Open an issue describing what you ran, what you expected, and what happened. A screenshot of
the console view helps. For anything security-sensitive, follow SECURITY.md instead of
opening a public issue.
