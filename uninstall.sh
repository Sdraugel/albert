#!/usr/bin/env bash
# Removes the Albert harness and the Albert Console from this machine.
# Mirrors uninstall.ps1 for macOS (LaunchAgent instead of Scheduled Task).
#
# Usage:
#   ./uninstall.sh
#   ./uninstall.sh --claude-dir DIR --console-dir DIR
set -euo pipefail

CLAUDE_DIR="${HOME}/.claude"
CONSOLE_DIR="${HOME}/Library/Application Support/AlbertConsole"
PORT=4400
CHAT_PORT=4401
LAUNCH_LABEL="com.albert.console"

info() { printf '  %s\n' "$*"; }
ok()   { printf '  [ok] %s\n' "$*"; }
warn() { printf '  [!] %s\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --claude-dir)  CLAUDE_DIR="$2"; shift 2 ;;
    --console-dir) CONSOLE_DIR="$2"; shift 2 ;;
    --port)        PORT="$2"; shift 2 ;;
    --chat-port)   CHAT_PORT="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    *) printf 'ERROR: unknown argument: %s\n' "$1" >&2; exit 1 ;;
  esac
done

printf '\nRemoving Albert\n'
info "ClaudeDir  : $CLAUDE_DIR"
info "ConsoleDir : $CONSOLE_DIR"
printf '\n'

# 1. LaunchAgent + port owners -------------------------------------------------------------
plist_path="${HOME}/Library/LaunchAgents/${LAUNCH_LABEL}.plist"
if [[ -f "$plist_path" ]] || launchctl print "gui/$(id -u)/${LAUNCH_LABEL}" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/${LAUNCH_LABEL}" 2>/dev/null || \
    launchctl unload "$plist_path" 2>/dev/null || true
  rm -f "$plist_path"
  ok "unregistered LaunchAgent ${LAUNCH_LABEL}"
else
  info "no ${LAUNCH_LABEL} LaunchAgent registered"
fi

# Kill anything still listening on the console/chat ports (orphans after unload).
free_port() {
  local p="$1"
  local pids
  pids="$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    info "nothing listening on port $p"
    return
  fi
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 0.3
  pids="$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
  ok "freed port $p"
}
free_port "$PORT"
free_port "$CHAT_PORT"

# 2. Console install copy -------------------------------------------------------------------
if [[ -d "$CONSOLE_DIR" ]]; then
  rm -rf "$CONSOLE_DIR"
  ok "removed console at $CONSOLE_DIR"
else
  info "no console install found at $CONSOLE_DIR"
fi

# 3. Harness files we own -------------------------------------------------------------------
loop_agents=(
  loop-planner loop-worker loop-data-scientist loop-designer loop-researcher
  loop-devops loop-verifier-dev loop-qa loop-skeptic-research loop-cleanup loop-scribe
)
owned_paths=(
  "$CLAUDE_DIR/skills/albert"
  "$CLAUDE_DIR/workflows/chunk-exec.js"
  "$CLAUDE_DIR/agent-runs/_emit.mjs"
  "$CLAUDE_DIR/agent-runs/_inbox.mjs"
)
for a in "${loop_agents[@]}"; do
  owned_paths+=("$CLAUDE_DIR/agents/${a}.md")
done

for p in "${owned_paths[@]}"; do
  if [[ -e "$p" ]]; then
    rm -rf "$p"
    ok "removed $p"
  fi
done

# 4. What we intentionally left ------------------------------------------------------------
generic_deps=(code-reviewer security-reviewer performance-reviewer doc-writer refactor-worker codebase-locator)
left_deps=()
for g in "${generic_deps[@]}"; do
  [[ -f "$CLAUDE_DIR/agents/${g}.md" ]] && left_deps+=("$g")
done
if [[ ${#left_deps[@]} -gt 0 ]]; then
  warn "left generic helper agents in place (remove by hand if unwanted): ${left_deps[*]}"
fi
run_store="$CLAUDE_DIR/agent-runs"
if [[ -d "$run_store" ]] && find "$run_store" -mindepth 1 -maxdepth 1 -type d | grep -q .; then
  warn "left your run history under $run_store (delete manually to erase it)"
fi

printf '\nDone.\n\n'
