#!/usr/bin/env bash
# Installs the Albert harness and the Albert Console on macOS (and other Unix).
# Mirrors install.ps1: same files, same {{TOKEN}} resolution, optional always-on
# LaunchAgent instead of a Windows Scheduled Task.
#
# Usage:
#   ./install.sh
#   ./install.sh --demo-only
#   ./install.sh --no-console
#   ./install.sh --no-task
#   ./install.sh --claude-dir DIR --projects-dir DIR --console-dir DIR --port N
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="${HOME}/.claude"
PROJECTS_DIR="$(dirname "$REPO")"
CONSOLE_DIR="${HOME}/Library/Application Support/AlbertConsole"
PORT=4400
DEMO_ONLY=0
NO_CONSOLE=0
NO_TASK=0
LAUNCH_LABEL="com.albert.console"

info() { printf '  %s\n' "$*"; }
ok()   { printf '  [ok] %s\n' "$*"; }
warn() { printf '  [!] %s\n' "$*"; }
step() { printf '\n%s\n' "$*"; }

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --claude-dir)   CLAUDE_DIR="$2"; shift 2 ;;
    --projects-dir) PROJECTS_DIR="$2"; shift 2 ;;
    --console-dir)  CONSOLE_DIR="$2"; shift 2 ;;
    --port)         PORT="$2"; shift 2 ;;
    --demo-only)    DEMO_ONLY=1; shift ;;
    --no-console)   NO_CONSOLE=1; shift ;;
    --no-task)      NO_TASK=1; shift ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

command -v node >/dev/null 2>&1 || die "Node.js is not on PATH. Install Node 20+ (26 recommended) and re-run."

# Resolve {{CLAUDE_DIR}} / {{PROJECTS_DIR}} / {{CONSOLE_DIR}}. On Unix paths use '/', so
# the JS-escape pass is a no-op unless a path somehow contains a backslash.
install_file() {
  local src="$1" dst="$2" js_escape="${3:-0}"
  local claude="$CLAUDE_DIR" projects="$PROJECTS_DIR" console="$CONSOLE_DIR"
  if [[ "$js_escape" == "1" ]]; then
    claude="${claude//\\/\\\\}"
    projects="${projects//\\/\\\\}"
    console="${console//\\/\\\\}"
  fi
  mkdir -p "$(dirname "$dst")"
  # Prefer python3 for reliable UTF-8 rewrite; fall back to sed.
  if command -v python3 >/dev/null 2>&1; then
    CLAUDE="$claude" PROJECTS="$projects" CONSOLE="$console" python3 - "$src" "$dst" <<'PY'
import os, sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8").read()
text = (text
  .replace("{{CLAUDE_DIR}}", os.environ["CLAUDE"])
  .replace("{{PROJECTS_DIR}}", os.environ["PROJECTS"])
  .replace("{{CONSOLE_DIR}}", os.environ["CONSOLE"]))
open(dst, "w", encoding="utf-8", newline="\n").write(text)
PY
  else
    sed -e "s|{{CLAUDE_DIR}}|${claude}|g" \
        -e "s|{{PROJECTS_DIR}}|${projects}|g" \
        -e "s|{{CONSOLE_DIR}}|${console}|g" \
        "$src" > "$dst"
  fi
}

if [[ "$DEMO_ONLY" -eq 1 ]]; then
  step "Generating synthetic demo data"
  demo_dir="$REPO/tools/demo-out"
  node "$REPO/tools/make-demo-data.mjs" "$demo_dir"
  ok "demo data at $demo_dir"
  step "Starting the console at http://localhost:${PORT}  (Ctrl+C to stop)"
  if command -v open >/dev/null 2>&1; then
    (sleep 1; open "http://localhost:${PORT}") &
  fi
  exec node "$REPO/console/server.mjs" \
    --port "$PORT" \
    --store "$demo_dir/agent-runs" \
    --projects "$demo_dir/projects" \
    --agents "$REPO/harness/agents"
fi

printf '\nInstalling Albert\n'
info "ClaudeDir   : $CLAUDE_DIR"
info "ProjectsDir : $PROJECTS_DIR"
info "ConsoleDir  : $CONSOLE_DIR"

step "Installing harness into Claude Code config"

install_file "$REPO/harness/skills/albert/SKILL.md" "$CLAUDE_DIR/skills/albert/SKILL.md"
ok "skill: /albert"

generic_deps="code-reviewer security-reviewer performance-reviewer doc-writer refactor-worker codebase-locator"
skipped_deps=()
for f in "$REPO"/harness/agents/*.md; do
  name="$(basename "$f" .md)"
  dst="$CLAUDE_DIR/agents/$(basename "$f")"
  skip=0
  for g in $generic_deps; do
    if [[ "$name" == "$g" && -f "$dst" ]]; then
      skipped_deps+=("$name")
      skip=1
      break
    fi
  done
  [[ "$skip" -eq 1 ]] && continue
  install_file "$f" "$dst"
done
ok "agents: 11 loop-* roster + generic helpers"
if [[ ${#skipped_deps[@]} -gt 0 ]]; then
  info "kept your existing helper agents: ${skipped_deps[*]}"
fi

install_file "$REPO/harness/workflows/chunk-exec.js" "$CLAUDE_DIR/workflows/chunk-exec.js" 1
ok "workflow: chunk-exec (parallel executor)"

install_file "$REPO/harness/runtime/_emit.mjs" "$CLAUDE_DIR/agent-runs/_emit.mjs"
install_file "$REPO/harness/runtime/_inbox.mjs" "$CLAUDE_DIR/agent-runs/_inbox.mjs"
install_file "$REPO/harness/runtime/agent-runs-README.md" "$CLAUDE_DIR/agent-runs/README.md"
ok "run store: _emit.mjs + _inbox.mjs + README (existing run data left untouched)"

if [[ "$NO_CONSOLE" -eq 0 ]]; then
  step "Installing Albert Console"
  while IFS= read -r -d '' f; do
    rel="${f#"$REPO/console/"}"
    install_file "$f" "$CONSOLE_DIR/$rel"
  done < <(find "$REPO/console" -type f -print0)
  chmod +x "$CONSOLE_DIR/start.sh" "$CONSOLE_DIR/stop.sh" 2>/dev/null || true
  ok "console installed at $CONSOLE_DIR"

  if [[ "$NO_TASK" -eq 0 ]]; then
    node_bin="$(command -v node)"
    plist_dir="${HOME}/Library/LaunchAgents"
    plist_path="${plist_dir}/${LAUNCH_LABEL}.plist"
    mkdir -p "$plist_dir"
    cat > "$plist_path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node_bin}</string>
    <string>${CONSOLE_DIR}/server.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${CONSOLE_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${CONSOLE_DIR}/console.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${CONSOLE_DIR}/console.stderr.log</string>
</dict>
</plist>
EOF
    launchctl bootout "gui/$(id -u)/${LAUNCH_LABEL}" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist_path"
    launchctl enable "gui/$(id -u)/${LAUNCH_LABEL}" 2>/dev/null || true
    launchctl kickstart -k "gui/$(id -u)/${LAUNCH_LABEL}" 2>/dev/null || \
      launchctl start "$LAUNCH_LABEL" 2>/dev/null || true
    ok "registered LaunchAgent '${LAUNCH_LABEL}' -> http://localhost:4400"
  else
    info "console agent not registered (--no-task). Start it with: ${CONSOLE_DIR}/start.sh"
  fi
fi

step "Installed."
printf '  Run a goal from any project:  '
printf '/albert "<your goal>"\n'
if [[ "$NO_CONSOLE" -eq 0 && "$NO_TASK" -eq 0 ]]; then
  printf '  Watch it live:                http://localhost:4400\n'
fi
printf '  Chat UI (optional):           see chat/README.md (requires Python 3.12)\n'
printf '  Remove everything:            ./uninstall.sh\n\n'
