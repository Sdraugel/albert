// Albert Console backend. Read-only monitor over the /albert run store.
// Zero dependencies by design: node: builtins only, bound to 127.0.0.1.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildUsage, snapshotUsage } from './lib/usage-adapter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- CLI args ----------
const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
const PORT = Number(argValue('--port', '4400')) || 4400;
const STORE_ROOT = path.resolve(argValue('--store', path.join(os.homedir(), '.claude', 'agent-runs')));
const AGENTS_DIR = path.resolve(argValue('--agents', path.join(os.homedir(), '.claude', 'agents')));
const PROJECTS_ROOT = path.resolve(argValue('--projects', path.join(os.homedir(), '.claude', 'projects')));
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- helpers ----------
function stripBom(s) {
  // Files on this box may carry a UTF-8 BOM, which JSON.parse rejects.
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

async function readJson(file, fallback) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(stripBom(raw));
  } catch (e) {
    return { error: `failed to parse ${path.basename(file)}: ${e.message}` };
  }
}

async function readText(file, fallback = '') {
  try {
    return stripBom(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function isUnsafeSegment(seg) {
  // Traversal guard: check both raw and decoded forms so %5C / %2E%2E cannot slip through.
  let decoded = seg;
  try {
    decoded = decodeURIComponent(seg);
  } catch {
    return true;
  }
  for (const s of [seg, decoded]) {
    if (s.includes('..') || s.includes('/') || s.includes('\\')) return true;
  }
  return false;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// ---------- roster ----------
const CLASS_MAP = {
  'loop-planner': 'planner',
  'loop-worker': 'producer',
  'loop-data-scientist': 'producer',
  'loop-designer': 'producer',
  'loop-researcher': 'producer',
  'loop-devops': 'producer',
  'loop-verifier-dev': 'critic',
  'loop-qa': 'critic',
  'loop-skeptic-research': 'critic',
  'loop-cleanup': 'maintainer',
  'loop-scribe': 'maintainer',
};

function parseFrontmatter(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const first = lines.findIndex((l) => l.trim() === '---');
  if (first === -1) return {};
  const second = lines.findIndex((l, i) => i > first && l.trim() === '---');
  if (second === -1) return {};
  const fm = {};
  let listKey = null;
  for (let i = first + 1; i < second; i++) {
    const line = lines[i];
    const listMatch = line.match(/^\s*-\s+(.+)$/);
    if (listMatch && listKey) {
      fm[listKey].push(listMatch[1].trim());
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value === '') {
      // YAML list form: value lines follow as "- Tool".
      fm[key] = [];
      listKey = key;
    } else {
      fm[key] = value.trim();
      listKey = null;
    }
  }
  return fm;
}

async function buildRoster() {
  const agents = [
    { name: 'albert', class: 'orchestrator', role: 'Agentic Loop Broker for Execution, Reasoning & Tasking', model: 'session', tools: [] },
  ];
  let files = [];
  try {
    files = (await fsp.readdir(AGENTS_DIR)).filter((f) => f.startsWith('loop-') && f.endsWith('.md'));
  } catch {
    return { agents };
  }
  files.sort();
  for (const f of files) {
    const fm = parseFrontmatter(await readText(path.join(AGENTS_DIR, f)));
    const name = typeof fm.name === 'string' ? fm.name : f.replace(/\.md$/, '');
    const desc = typeof fm.description === 'string' ? fm.description : '';
    const dot = desc.indexOf('.');
    const role = dot === -1 ? desc : desc.slice(0, dot + 1);
    let tools = [];
    if (Array.isArray(fm.tools)) tools = fm.tools;
    else if (typeof fm.tools === 'string') tools = fm.tools.split(',').map((t) => t.trim()).filter(Boolean);
    agents.push({
      name,
      class: CLASS_MAP[name] || 'producer',
      role,
      model: typeof fm.model === 'string' && fm.model ? fm.model : 'sonnet',
      tools,
    });
  }
  return { agents };
}

// ---------- runs ----------
const PROGRESS_SUMMARY_KEYS = ['status', 'iteration', 'iterations_spent', 'tokens_spent', 'tasks_done', 'budget'];
// Only the documented progress.json schema fields; every other top-level
// string value is surfaced generically in progressNotes, never assumed.
const KNOWN_PROGRESS_KEYS = new Set([
  'run_id', 'status', 'iteration', 'iterations_spent', 'tokens_spent', 'tasks_done',
  'stuck_counter', 'iters_since_cleanup', 'budget',
]);

async function buildRuns() {
  const index = await readJson(path.join(STORE_ROOT, 'index.json'), { active_run_id: null, runs: [] });
  const indexRuns = Array.isArray(index.runs) ? index.runs : [];
  const runs = [];
  for (const r of indexRuns) {
    // A malformed registry entry (non-string id) must not 500 the whole runs list.
    if (!r || typeof r.id !== 'string') continue;
    let progress = await readJson(path.join(STORE_ROOT, r.id, 'progress.json'), {});
    // Valid JSON that is not an object (e.g. a truncated write leaving `null`)
    // must not take down the endpoint.
    if (!progress || typeof progress !== 'object' || Array.isArray(progress)) progress = {};
    const summary = {};
    for (const k of PROGRESS_SUMMARY_KEYS) summary[k] = progress[k] ?? null;
    runs.push({
      id: r.id,
      project: r.project_path ? path.basename(r.project_path) : null,
      project_path: r.project_path ?? null,
      status: progress.status ?? null,
      indexStatus: r.status ?? null,
      progress: summary,
    });
  }
  return { active_run_id: index.active_run_id ?? null, runs };
}

function parseLedger(text) {
  const rows = [];
  const lines = text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '');
  for (let i = 1; i < lines.length; i++) {
    // Notes may contain commas, so only the first 5 commas delimit fields.
    const fields = [];
    let rest = lines[i];
    for (let j = 0; j < 5; j++) {
      const idx = rest.indexOf(',');
      if (idx === -1) {
        fields.push(rest);
        rest = '';
      } else {
        fields.push(rest.slice(0, idx));
        rest = rest.slice(idx + 1);
      }
    }
    rows.push({
      iteration: fields[0] ?? '',
      task_id: fields[1] ?? '',
      role: fields[2] ?? '',
      verdict: fields[3] ?? '',
      evidence: fields[4] ?? '',
      notes: rest,
    });
  }
  return rows;
}

async function buildRunDetail(id) {
  const dir = path.join(STORE_ROOT, id);
  try {
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) return null;
  } catch {
    return null;
  }

  const goal = await readText(path.join(dir, 'goal.md'), '');
  const project = await readJson(path.join(dir, 'project.json'), {});
  const tasks = await readJson(path.join(dir, 'tasks.json'), {});
  const progress = await readJson(path.join(dir, 'progress.json'), {});

  const progressNotes = [];
  if (progress && typeof progress === 'object' && !Array.isArray(progress)) {
    for (const [key, value] of Object.entries(progress)) {
      if (!KNOWN_PROGRESS_KEYS.has(key) && typeof value === 'string') {
        progressNotes.push({ key, text: value });
      }
    }
  }

  const ledger = parseLedger(await readText(path.join(dir, 'ledger.csv'), ''));

  const iterations = [];
  try {
    const entries = await fsp.readdir(path.join(dir, 'iterations'), { withFileTypes: true });
    const numbered = entries.filter((e) => e.isDirectory() && /^\d+$/.test(e.name));
    numbered.sort((a, b) => Number(a.name) - Number(b.name));
    for (const e of numbered) {
      let logs = [];
      try {
        const files = await fsp.readdir(path.join(dir, 'iterations', e.name), { withFileTypes: true });
        logs = files.filter((f) => f.isFile()).map((f) => f.name);
      } catch { /* unreadable iteration dir: list it with no logs */ }
      iterations.push({ n: Number(e.name), logs });
    }
  } catch { /* no iterations dir yet */ }

  let events = [];
  const eventsText = await readText(path.join(dir, 'events.jsonl'), '');
  if (eventsText) {
    const parsed = [];
    for (const line of eventsText.split('\n')) {
      const trimmed = line.replace(/\r$/, '').trim();
      if (!trimmed) continue;
      try {
        parsed.push(JSON.parse(stripBom(trimmed)));
      } catch { /* skip malformed event lines */ }
    }
    events = parsed.slice(-500);
  }

  return { id, goal, project, tasks, progress, progressNotes, ledger, iterations, events };
}

// ---------- sessions ----------
// Read-only mirror of Claude Code's own transcripts, via lib/session-tailer.mjs.
// This half is strictly additive: if the tailer module is missing or throws on
// start, `tailer` stays null, the endpoints degrade to empty, and the run-store
// half keeps serving.
let tailer = null;

function listSessions() {
  if (!tailer) return [];
  let sessions;
  try {
    sessions = tailer.getSessions();
  } catch {
    return [];
  }
  if (!Array.isArray(sessions)) return [];
  // Newest activity first; a missing/unparseable last_activity sorts last.
  return [...sessions].sort((a, b) => {
    const at = Date.parse(a?.last_activity ?? '') || 0;
    const bt = Date.parse(b?.last_activity ?? '') || 0;
    return bt - at;
  });
}

async function startTailer() {
  let createSessionTailer;
  try {
    ({ createSessionTailer } = await import('./lib/session-tailer.mjs'));
  } catch (e) {
    console.error(`session tailer unavailable (${e.message}); sessions endpoints will be empty`);
    return;
  }
  try {
    tailer = createSessionTailer({
      projectsRoot: PROJECTS_ROOT,
      onEvent: (ev) => broadcast('session', ev),
      onSessionUpdate: (summary) => broadcast('session-state', summary),
      logger: console,
    });
    // Awaited: start() is async, so an unawaited rejection would escape this
    // synchronous catch as a fatal unhandled rejection instead of degrading.
    await tailer.start();
  } catch (e) {
    // A tailer failure must never take the run-store half down with it.
    tailer = null;
    console.error(`session tailer failed to start: ${e.message}`);
  }
}

// ---------- SSE ----------
const sseClients = new Set();
// Byte offsets per events.jsonl so only lines written after startup are streamed.
const eventsOffsets = new Map();

function sseSend(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch { /* client already gone; close handler removes it */ }
}

function broadcast(event, data) {
  for (const res of sseClients) sseSend(res, event, data);
}

async function initEventsOffsets() {
  try {
    const entries = await fsp.readdir(STORE_ROOT, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const file = path.join(STORE_ROOT, e.name, 'events.jsonl');
      try {
        eventsOffsets.set(file, (await fsp.stat(file)).size);
      } catch { /* no events.jsonl yet for this run */ }
    }
  } catch { /* store root missing; watcher setup will complain instead */ }
}

async function streamNewEventLines(file, runId) {
  let size;
  try {
    size = (await fsp.stat(file)).size;
  } catch {
    return;
  }
  let offset = eventsOffsets.get(file) ?? 0;
  if (size < offset) offset = 0; // file truncated/rewritten: replay from the top
  if (size === offset) return;
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(size - offset);
    const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
    // Only consume complete lines: a trailing partial line (writer mid-flush)
    // stays in the file and is re-read once its newline lands, so split
    // appends are never dropped.
    const lastNl = bytesRead > 0 ? buf.lastIndexOf(0x0a, bytesRead - 1) : -1;
    if (lastNl === -1) return;
    eventsOffsets.set(file, offset + lastNl + 1);
    const chunk = stripBom(buf.toString('utf8', 0, lastNl + 1));
    for (const line of chunk.split('\n')) {
      const trimmed = line.replace(/\r$/, '').trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        broadcast('harness', obj);
      } catch { /* skip partial or malformed lines */ }
    }
  } catch { /* transient read failure; next change event retries */ } finally {
    if (fh) await fh.close().catch(() => {});
  }
  void runId;
}

const pendingChanges = new Set();
let debounceTimer = null;

async function processPendingChanges() {
  const changed = [...pendingChanges];
  pendingChanges.clear();
  for (const rel of changed) {
    const parts = rel.split(/[\\/]/).filter(Boolean);
    const base = parts[parts.length - 1];
    if (base === 'events.jsonl' && parts.length >= 2) {
      await streamNewEventLines(path.join(STORE_ROOT, rel), parts[0]);
    } else if (base === 'progress.json' && parts.length >= 2) {
      const progress = await readJson(path.join(STORE_ROOT, rel), {});
      broadcast('state', { run_id: parts[0], progress });
    } else if (rel === 'index.json' || base === 'index.json') {
      const index = await readJson(path.join(STORE_ROOT, 'index.json'), { active_run_id: null, runs: [] });
      broadcast('state', { run_id: null, progress: null, index });
    }
  }
}

function startWatcher() {
  try {
    fs.watch(STORE_ROOT, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      pendingChanges.add(filename.toString());
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        processPendingChanges().catch(() => {});
      }, 150);
    });
  } catch (e) {
    console.error(`watch failed for ${STORE_ROOT}: ${e.message}`);
  }
}

setInterval(() => {
  for (const res of sseClients) {
    try {
      res.write(': hb\n\n');
    } catch { /* close handler cleans up */ }
  }
}, 25000).unref();

async function handleSse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
  const [runs, roster] = await Promise.all([buildRuns(), buildRoster()]);
  // Burn is in-memory, but the plan label is only included if it was already cached:
  // a new client must never wait on a process spawn for its init snapshot.
  let usage = null;
  try {
    usage = snapshotUsage(tailer ? tailer.getBurn() : null);
  } catch {
    usage = null;
  }
  sseSend(res, 'init', {
    runs: runs.runs,
    roster: roster.agents,
    active_run_id: runs.active_run_id,
    sessions: listSessions(),
    usage,
  });
}

// ---------- static ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (rel.split('/').some(isUnsafeSegment)) {
    return sendJson(res, 400, { error: 'invalid path' });
  }
  const file = path.join(PUBLIC_DIR, ...rel.split('/'));
  let data;
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) return sendJson(res, 404, { error: 'not found' });
    data = await fsp.readFile(file);
  } catch {
    return sendJson(res, 404, { error: 'not found' });
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  res.end(data);
}

// ---------- router ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const pathname = url.pathname;

    if (pathname === '/events') return await handleSse(req, res);
    if (pathname === '/api/roster') return sendJson(res, 200, await buildRoster());
    if (pathname === '/api/runs') return sendJson(res, 200, await buildRuns());
    if (pathname === '/api/sessions') return sendJson(res, 200, { sessions: listSessions() });

    // Plan label + local burn. Fully isolated: the adapter degrades internally, this
    // catch is the belt to its braces, and either way nothing here can touch the run
    // store, the tailer or the stream.
    if (pathname === '/api/usage') {
      let usage;
      try {
        usage = await buildUsage(tailer ? tailer.getBurn() : null);
      } catch {
        usage = snapshotUsage(null);
      }
      return sendJson(res, 200, usage);
    }

    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch) {
      const rawId = sessionMatch[1];
      if (isUnsafeSegment(rawId)) return sendJson(res, 400, { error: 'invalid path' });
      const id = decodeURIComponent(rawId);
      let summary = null;
      try {
        summary = tailer ? tailer.getSession(id) : null;
      } catch {
        summary = null;
      }
      if (!summary) return sendJson(res, 404, { error: 'session not found' });
      // getSession() already attaches a capped, adapter-built events array.
      return sendJson(res, 200, summary);
    }

    const logMatch = pathname.match(/^\/api\/runs\/([^/]+)\/logs\/([^/]+)\/([^/]+)$/);
    if (logMatch) {
      const [, rawId, rawN, rawFile] = logMatch;
      if (isUnsafeSegment(rawId) || isUnsafeSegment(rawN) || isUnsafeSegment(rawFile)) {
        return sendJson(res, 400, { error: 'invalid path' });
      }
      const id = decodeURIComponent(rawId);
      const n = decodeURIComponent(rawN);
      const file = decodeURIComponent(rawFile);
      const logPath = path.join(STORE_ROOT, id, 'iterations', n, file);
      try {
        const text = await fsp.readFile(logPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(text);
      } catch {
        return sendJson(res, 404, { error: 'log not found' });
      }
    }

    const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (runMatch) {
      const rawId = runMatch[1];
      if (isUnsafeSegment(rawId)) return sendJson(res, 400, { error: 'invalid path' });
      const detail = await buildRunDetail(decodeURIComponent(rawId));
      if (!detail) return sendJson(res, 404, { error: 'run not found' });
      return sendJson(res, 200, detail);
    }

    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
    return serveStatic(res, pathname);
  } catch (e) {
    if (res.headersSent) {
      // Headers already went out (e.g. an SSE stream): a JSON 500 would throw
      // ERR_HTTP_HEADERS_SENT out of this catch and crash the process. Just end.
      try { res.end(); } catch { /* client already gone */ }
      return;
    }
    return sendJson(res, 500, { error: e.message });
  }
});

await initEventsOffsets();
startWatcher();
server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `albert-console listening on http://127.0.0.1:${PORT} (store: ${STORE_ROOT}, projects: ${PROJECTS_ROOT})`
  );
  // Started only once the socket is up, so a slow transcript scan cannot delay
  // the server becoming reachable. Not awaited (this callback is sync), so the
  // rejection path needs its own handler to stay non-fatal.
  startTailer().catch((e) => {
    tailer = null;
    console.error(`session tailer failed to start: ${e.message}`);
  });
});
