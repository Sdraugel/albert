'use strict';

/* ALBERT CONSOLE frontend. Vanilla JS, no dependencies.
   All dynamic text flows through esc() + textContent; no innerHTML with data. */

/* PRIVACY CONTRACT (Claude Code sessions).
   Session data originates in Claude Code transcripts, which hold full user prompts
   and full tool output across every project on this box. The server-side adapter
   allowlists metadata before it ever reaches the wire; this file is the second gate.
   Every session object rendered here is rebuilt field-by-field in normSession() /
   normSessionEvent() from NAMED fields only. Never spread or Object.assign a payload
   from /api/sessions into UI state, and never add a field to these normalizers that
   is not in the fixed shape: session_id, project, cwd, git_branch, surface, title,
   started, last_activity, status, turns, tool_calls, dispatches, tokens,
   agents[{agentType,count,lastSeen,model}], is_harness, harness_agents[],
   compliance.signals[{policy,main_calls,delegated,verdict}];
   events {ts,session_id,project,type,actor,target,summary}.
   is_harness/harness_agents are derived from agents[] server-side (loop-* only).
   Prompts, message content, tool inputs, and tool results are not renderable here. */

/* ---------------- helpers ---------------- */

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

// Single escape choke point: everything renders via textContent.
function esc(v) { return v == null ? '' : String(v); }

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = esc(text);
  return n;
}

// The harness emits the orchestrator as "controller"; older data says "chief". Resolve all
// spellings to one id so lookups, filters and heartbeats agree.
const ALBERT_ID = 'albert';
const ALBERT_ALIASES = new Set(['albert', 'chief', 'controller', 'orchestrator']);
function canonAgent(name) {
  const n = String(name || '').toLowerCase().trim();
  return ALBERT_ALIASES.has(n) ? ALBERT_ID : String(name || '');
}
function displayAgent(name) {
  return canonAgent(name) === ALBERT_ID ? 'A.L.B.E.R.T.' : String(name || '').replace(/^loop-/, '').toUpperCase();
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs) {
  const n = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const k of Object.keys(attrs)) n.setAttribute(k, attrs[k]);
  return n;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(url + ' -> HTTP ' + res.status);
  const txt = await res.text();
  // Files on this box may carry a UTF-8 BOM; strip before parsing.
  return JSON.parse(txt.replace(/^\uFEFF/, ''));
}

function safeParse(txt) {
  try { return JSON.parse(String(txt).replace(/^\uFEFF/, '')); } catch (e) { return null; }
}

function tsMs(ts) {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

function fmtRel(ms) {
  if (ms == null) return '-';
  const d = Date.now() - ms;
  if (d < 0) return 'now';
  const s = Math.floor(d / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function fmtCompact(n) {
  if (n == null || !Number.isFinite(Number(n))) return '-';
  n = Number(n);
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

function fmtDur(ms) {
  if (ms <= 0) return 'EXPIRED';
  const m = Math.floor(ms / 60000);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

/* ---------------- constants ---------------- */

const CLASS_ORDER = ['orchestrator', 'planner', 'producer', 'critic', 'maintainer'];
const CLASS_LABEL = {
  orchestrator: 'ORCHESTRATOR', planner: 'PLANNER', producer: 'PRODUCERS',
  critic: 'CRITICS', maintainer: 'MAINTAINERS',
};
const HOT_MS = 60 * 1000;          // connector/node pulse window
const ALBERT_ACTIVE_MS = 10 * 60 * 1000;   // run counts as looping only if it emitted an event this recently
const WORK_WINDOW_MS = 10 * 60 * 1000;     // a dispatched-but-unreturned agent stays "working" only this long
const FEED_CAP = 500;
const FEED_DOM_CAP = 300;
const SESSION_FEED_CAP = 300;
const ACTIVITY_ROWS = 10;     // work items the ACTIVITY panel keeps in the DOM
const ACTIVITY_SCAN = 120;    // newest events read per stream when collecting work
const ACTIVE_PREFETCH = 4;    // live sessions whose history is pulled for the panel
const ACTIVITY_KEY = 'hc.activity';
const ACTIVITY_OPEN_MIN = 1200;  // below this CSS width the overlay starts collapsed

const FILTER_CHIPS = [
  ['all', 'ALL'], ['dispatch', 'DISPATCH'], ['verify', 'VERIFY'], ['gate', 'GATE'],
  ['qa', 'QA'], ['pr', 'PR+MERGE'], ['system', 'SYSTEM'], ['sessions', 'SESSIONS'],
];

// The main Claude Code session speaks as this actor in session events.
const SESSION_MAIN_ACTOR = 'claude-code';

/* ---------------- state ---------------- */

const state = {
  connected: false,
  roster: [],
  byName: new Map(),
  runs: [],
  activeRunId: null,
  details: new Map(),   // runId -> /api/runs/:id payload
  feeds: new Map(),     // runId -> normalized events, newest first
  lastSeen: new Map(),  // agent name -> ms of last appearance in a HARNESS feed
  view: 'graph',
  commsRunId: null,
  commsFilter: 'all',
  commsAgent: null,
  sessionsSel: null,    // selected HARNESS run id (runs and sessions are different nouns)
  // Claude Code session mirror. Kept apart from the harness maps on purpose:
  // session traffic must never light up a harness Fleet card or a Graph node.
  sessions: [],              // normalized session summaries, newest first
  sessionDetails: new Map(), // session_id -> { events: [...] }
  sessionFeed: [],           // normalized session events, newest first
  sessionSeen: new Map(),    // agentType -> ms last seen in session traffic
  usage: null,               // parsed /api/usage numbers; never carries a credential
  sessionSel: null,          // selected session_id
  detailKind: 'run',         // which noun the detail pane is showing: 'run' | 'session'
  // The GRAPH is global: one activity map over every session and every store run.
  // It has no focus and is never pinned to a run.
  graphNodes: new Map(),  // agent -> {g, refreshChips, group}
  graphLinks: new Map(),  // agent -> connector line
  graphCore: null,
};

/* ---------------- events / feed ---------------- */

function normEvent(raw, runId) {
  return {
    ts: raw.ts || null,
    ms: tsMs(raw.ts),
    run_id: raw.run_id || runId,
    type: esc(raw.type || 'event'),
    actor: esc(raw.actor || ''),
    target: esc(raw.target || ''),
    task_id: esc(raw.task_id || ''),
    iteration: raw.iteration,
    summary: esc(raw.summary || ''),
    ledger: false,
  };
}

function guessAgentForRole(role) {
  const r = String(role || '').toLowerCase().trim();
  if (!r) return '';
  if (canonAgent(r) === ALBERT_ID) return ALBERT_ID;
  for (const a of state.roster) {
    const short = a.name.replace(/^loop-/, '').toLowerCase();
    if (short === r || short.includes(r) || r.includes(short)) return a.name;
  }
  return r;
}

function ledgerToEvents(rows, runId) {
  return (rows || []).map((r) => ({
    ts: null, ms: null, run_id: runId,
    type: 'ledger.' + String(r.verdict || 'row').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    actor: guessAgentForRole(r.role),
    target: esc(r.task_id || ''),
    task_id: esc(r.task_id || ''),
    iteration: Number(r.iteration),
    summary: [r.verdict, r.notes].filter(Boolean).map(esc).join(' :: '),
    ledger: true,
  }));
}

function badgeFor(ev) {
  if (ev.isSession) return ['SESSION', 'b-session'];
  if (ev.ledger) return ['LEDGER', 'b-ledger'];
  const t = ev.type;
  if (t === 'task.picked') return ['PICK', 'b-dispatch'];
  if (t.endsWith('.dispatched')) return ['DISPATCH', 'b-dispatch'];
  if (t === 'verify.result') return ['VERIFY', 'b-verify'];
  if (t === 'gate.result') return ['GATE', 'b-gold'];
  if (t === 'qa.result') return ['QA', 'b-qa'];
  if (t === 'skeptic.result') return ['SKEPTIC', 'b-qa'];
  if (t === 'pr.opened') return ['PR', 'b-gold'];
  if (t === 'merge') return ['MERGE', 'b-gold'];
  if (t === 'task.done') return ['DONE', 'b-verify'];
  if (t === 'task.failed') return ['FAILED', 'b-error'];
  if (t === 'run.stopped') return ['STOP', 'b-error'];
  if (t === 'run.init') return ['INIT', 'b-dim'];
  if (t === 'plan.created') return ['PLAN', 'b-dispatch'];
  if (t === 'cleanup.run') return ['CLEANUP', 'b-dim'];
  if (t === 'checkpoint') return ['CKPT', 'b-gold'];
  if (t === 'notify') return ['NOTIFY', 'b-dim'];
  if (t === 'test.ping') return ['PING', 'b-dim'];
  return [t.toUpperCase().slice(0, 10), 'b-dim'];
}

function filterCat(ev) {
  const t = ev.type;
  // Session events own their own category, so the harness chips keep their exact
  // previous membership and never gain session rows.
  if (ev.isSession) return 'sessions';
  if (ev.ledger) return /pass|done|fail/.test(t) ? 'verify' : 'system';
  if (t.endsWith('.dispatched') || t === 'task.picked' || t === 'plan.created') return 'dispatch';
  if (t === 'verify.result' || t === 'task.done' || t === 'task.failed') return 'verify';
  if (t === 'gate.result') return 'gate';
  if (t === 'qa.result' || t === 'skeptic.result') return 'qa';
  if (t === 'pr.opened' || t === 'merge') return 'pr';
  return 'system';
}

// Records a heartbeat for ANY agent name, roster or not: a harness event naming an
// unknown agent used to be dropped here, which lost the sighting entirely. The Fleet
// sections stay roster-driven (renderFleet iterates state.roster); the Graph builds
// its node set from all observed traffic, so an unknown agent shows up there as a
// session-agent node rather than being silently discarded.
function touchSeen(map, name, ms) {
  if (!name || ms == null) return;
  const cur = map.get(name);
  if (cur == null || ms > cur) map.set(name, ms);
}

function touchAgent(name, ms) { touchSeen(state.lastSeen, canonAgent(name), ms); }
function touchSessionAgent(name, ms) { touchSeen(state.sessionSeen, name, ms); }

function setFeed(runId, detail) {
  let feed;
  const evs = detail.events || [];
  if (evs.length) {
    feed = evs.map((e) => normEvent(e, runId)).reverse(); // API is oldest-first
  } else {
    feed = ledgerToEvents(detail.ledger, runId).reverse(); // synthesize so COMMS is never empty
  }
  state.feeds.set(runId, feed.slice(0, FEED_CAP));
  for (const ev of feed) { touchAgent(ev.actor, ev.ms); touchAgent(ev.target, ev.ms); }
}

function ingestLive(raw) {
  const ev = normEvent(raw, raw && raw.run_id);
  if (!ev.run_id) return;
  const feed = state.feeds.get(ev.run_id) || [];
  feed.unshift(ev);
  if (feed.length > FEED_CAP) feed.length = FEED_CAP;
  state.feeds.set(ev.run_id, feed);
  touchAgent(ev.actor, ev.ms || Date.now());
  touchAgent(ev.target, ev.ms || Date.now());
  if (state.view === 'comms' && state.commsRunId === ev.run_id) prependLiveRow(ev);
  if (state.view === 'fleet') patchFleet();
  updateGraph();
}

/* ---------------- Claude Code sessions: ingest ---------------- */
/* Field-by-field rebuilds. See the PRIVACY CONTRACT at the top of this file before
   adding anything here: no spread, no passthrough, allowlisted names only. */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normSessionAgents(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const a of list) {
    if (!a || !a.agentType) continue;
    out.push({
      agentType: esc(a.agentType),
      count: num(a.count),
      lastSeen: a.lastSeen || null,
      model: esc(a.model || ''),
    });
  }
  return out;
}

function normSignals(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list) {
    if (!s || !s.policy) continue;
    out.push({
      policy: esc(s.policy),
      main_calls: num(s.main_calls),
      delegated: num(s.delegated),
      verdict: esc(s.verdict || ''),
    });
  }
  return out;
}

// loop-* agent type names, derived server-side from agents[]. Strings only.
function normHarnessAgents(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const t of list) {
    if (typeof t === 'string' && t) out.push(esc(t));
  }
  return out;
}

function normSession(raw) {
  if (!raw || !raw.session_id) return null;
  return {
    session_id: esc(raw.session_id),
    project: esc(raw.project || ''),
    cwd: esc(raw.cwd || ''),
    git_branch: esc(raw.git_branch || ''),
    surface: esc(raw.surface || 'unknown'),
    title: esc(raw.title || ''),
    started: raw.started || null,
    last_activity: raw.last_activity || null,
    ms: tsMs(raw.last_activity),
    status: esc(raw.status || ''),
    turns: num(raw.turns),
    tool_calls: num(raw.tool_calls),
    dispatches: num(raw.dispatches),
    tokens: num(raw.tokens),
    agents: normSessionAgents(raw.agents),
    is_harness: raw.is_harness === true,
    harness_agents: normHarnessAgents(raw.harness_agents),
    compliance: { signals: normSignals(raw.compliance && raw.compliance.signals) },
  };
}

function normSessionEvent(raw) {
  if (!raw) return null;
  return {
    ts: raw.ts || null,
    ms: tsMs(raw.ts),
    run_id: null,
    session_id: esc(raw.session_id || ''),
    project: esc(raw.project || ''),
    type: esc(raw.type || 'session.event'),
    actor: esc(raw.actor || ''),
    target: esc(raw.target || ''),
    task_id: '',
    iteration: null,
    // Derived label from the adapter; never a prompt body.
    summary: esc(raw.summary || ''),
    ledger: false,
    isSession: true,
  };
}

function sortSessions() {
  state.sessions.sort((a, b) => (b.ms || 0) - (a.ms || 0)); // newest first
}

function registerSessionAgents(s) {
  for (const a of s.agents) touchSessionAgent(a.agentType, tsMs(a.lastSeen));
}

function applySessions(payload) {
  const list = Array.isArray(payload) ? payload : (payload && payload.sessions) || [];
  const out = [];
  for (const raw of list) {
    const s = normSession(raw);
    if (s) { out.push(s); registerSessionAgents(s); }
  }
  state.sessions = out;
  sortSessions();
  if (state.sessionSel && !state.sessions.some((s) => s.session_id === state.sessionSel)) {
    state.sessionSel = null;
    if (state.detailKind === 'session') state.detailKind = 'run';
  }
  ensureActiveSessionDetails();
}

// The ACTIVITY panel and the RECENT WORK tooltip read per-dispatch descriptions, which
// live in a session's own event history. Pull it for the LIVE sessions only, newest
// first and capped, so the panel says something the moment the console opens instead of
// only after the reader happens to click a row.
function ensureActiveSessionDetails() {
  let pulled = 0;
  for (const s of state.sessions) {
    if (pulled >= ACTIVE_PREFETCH) break;
    if (String(s.status || '').toLowerCase() !== 'active') continue;
    pulled++;
    if (state.sessionDetails.has(s.session_id)) continue;
    ensureSessionDetail(s.session_id).then(() => updateGraph()).catch(() => {});
  }
}

// 'session-state' SSE: one summary, upserted in place.
function applySessionState(raw) {
  const s = normSession(raw);
  if (!s) return;
  const i = state.sessions.findIndex((x) => x.session_id === s.session_id);
  if (i >= 0) state.sessions[i] = s;
  else state.sessions.push(s);
  sortSessions();
  registerSessionAgents(s);
  // A summary can introduce an agentType the AMBIENT grid has no card for yet,
  // so this rebuilds rather than patches.
  if (state.view === 'fleet') renderFleet();
  if (state.view === 'sessions') patchSessions(s);
  // The summary carries this session's status + per-agent lastSeen, which feed the
  // global map (they light/dim nodes, and a first-seen agent type adds a spoke).
  updateGraph();
}

function ingestSessionEvent(raw) {
  const ev = normSessionEvent(raw);
  if (!ev || !ev.session_id) return;
  state.sessionFeed.unshift(ev);
  if (state.sessionFeed.length > SESSION_FEED_CAP) state.sessionFeed.length = SESSION_FEED_CAP;
  const ms = ev.ms || Date.now();
  // Only the non-main side of the route is an agent type worth a heartbeat.
  if (ev.actor && ev.actor !== SESSION_MAIN_ACTOR) touchSessionAgent(ev.actor, ms);
  if (ev.target && ev.target !== SESSION_MAIN_ACTOR) touchSessionAgent(ev.target, ms);
  const detail = state.sessionDetails.get(ev.session_id);
  if (detail && Array.isArray(detail.events)) detail.events.unshift(ev);
  if (state.view === 'comms') prependLiveRow(ev);
  if (state.view === 'fleet') patchFleet();
  // Every session-table column comes from the summary ('session-state'), so a live
  // event only ever adds a timeline row on the shown session. Transcripts append per
  // message across every open project: a full renderSessions() per event would snap
  // the reader's scroll to the top and blur the focused row mid-Tab. When the detail
  // is not cached yet the pane is on its loading state and ensureSessionDetail renders.
  if (state.view === 'sessions' && detail && state.detailKind === 'session'
      && ev.session_id === state.sessionSel) {
    prependSessionEventRow(ev);
  }
  // A live agent.dispatched / agent.done in ANY session must light or clear its node
  // within ~1s, so refresh the global graph on every session event.
  updateGraph();
}

async function fetchSessions() {
  try {
    applySessions(await fetchJSON('/api/sessions'));
  } catch (e) {
    // Endpoint absent or unreachable: the session groups render empty states.
  }
}

// One in-flight request per session: the panel prefetch fires on every sessions refresh,
// and without this a burst of index events would stack duplicate GETs for the same id.
const sessionDetailPending = new Map();

function ensureSessionDetail(id) {
  if (!id) return Promise.resolve(null);
  if (state.sessionDetails.has(id)) return Promise.resolve(state.sessionDetails.get(id));
  const pending = sessionDetailPending.get(id);
  if (pending) return pending;
  const p = fetchSessionDetail(id);
  sessionDetailPending.set(id, p);
  p.catch(() => {}).then(() => sessionDetailPending.delete(id));
  return p;
}

async function fetchSessionDetail(id) {
  const raw = await fetchJSON('/api/sessions/' + encodeURIComponent(id));
  const events = [];
  const rawEvents = Array.isArray(raw && raw.events) ? raw.events : [];
  for (const r of rawEvents) {
    const ev = normSessionEvent(r);
    if (ev) events.push(ev);
  }
  events.sort((a, b) => (b.ms || 0) - (a.ms || 0)); // newest first
  const summary = normSession(raw && raw.session ? raw.session : raw);
  const detail = { events, summary };
  state.sessionDetails.set(id, detail);
  if (summary) registerSessionAgents(summary);
  return detail;
}

function sessionById(id) {
  return state.sessions.find((s) => s.session_id === id) || null;
}

function sessionLabel(s) {
  return s.title || (s.session_id ? s.session_id.slice(0, 8) : '-');
}

/* ---------------- derived agent state ---------------- */

// Live session events bucketed by session, built once per pass. The graph reads EVERY
// session now, and re-filtering the whole live buffer per session was O(sessions x buffer).
function liveSessionEventIndex() {
  const by = new Map();
  for (const ev of state.sessionFeed) {
    const list = by.get(ev.session_id);
    if (list) list.push(ev);
    else by.set(ev.session_id, [ev]);
  }
  return by;
}

// Events for one session, newest first: the loaded detail (history + live) when
// present, else whatever live events have streamed in this page load.
function sessionEventsFor(id, liveIndex) {
  const detail = state.sessionDetails.get(id);
  if (detail && Array.isArray(detail.events) && detail.events.length) return detail.events;
  if (liveIndex) return liveIndex.get(id) || [];
  return state.sessionFeed.filter((e) => e.session_id === id);
}

// A route endpoint that names a real agent, or '' for the orchestrator / main session
// / an empty slot. The core owns A.L.B.E.R.T. and the main session actor, so neither
// may become a spoke.
function agentPartyName(raw) {
  const name = typeof raw === 'string' ? raw : '';
  if (!name || name === SESSION_MAIN_ACTOR) return '';
  return canonAgent(name) === ALBERT_ID ? '' : name;
}

// Store-run working set (unchanged behaviour), keyed on an explicit run id.
function computeRunWorking(runId) {
  const working = new Set();
  const feed = state.feeds.get(runId) || [];
  const now = Date.now();
  const run = state.runs.find((r) => r.id === runId);
  const st = run && run.status;
  const newest = feed.find((e) => e.ms != null);
  // A run is genuinely looping only if its status is live AND it emitted an event recently.
  // A paused or long-idle run has nobody working, whatever old dispatches its feed still holds.
  const runActive = (st === 'running' || st === 'checkpoint') && newest && (now - newest.ms < ALBERT_ACTIVE_MS);
  if (!runActive) return working;

  const laterActors = new Set();
  const decided = new Set();
  for (const ev of feed) { // newest first: laterActors = actors of strictly newer events
    if (ev.type.endsWith('.dispatched') && ev.target && !decided.has(ev.target)) {
      decided.add(ev.target);
      // Dispatched with no later return = still working, but only while the dispatch is
      // recent. Otherwise a subagent whose return event we missed glows forever (a stray
      // dispatch once pinned loop-worker gold for 23h).
      if (!laterActors.has(ev.target) && ev.ms != null && now - ev.ms < WORK_WINDOW_MS) {
        working.add(ev.target);
      }
    }
    if (ev.actor) laterActors.add(ev.actor);
  }
  working.add(ALBERT_ID);
  return working;
}

// Session working set: the SAME dispatched-without-recent-return rule, read from the
// session's own live agent events. Core (A.L.B.E.R.T.) lights while the session is
// active with recent activity; nothing lights once the session goes idle.
function computeSessionWorking(session, liveIndex) {
  const working = new Set();
  if (!session) return working;
  const now = Date.now();
  const events = sessionEventsFor(session.session_id, liveIndex);
  const newest = events.find((e) => e.ms != null);
  const active = String(session.status || '').toLowerCase() === 'active' && newest && (now - newest.ms < ALBERT_ACTIVE_MS);
  if (!active) return working;

  const laterActors = new Set();
  const decided = new Set();
  for (const ev of events) { // newest first
    if (ev.type.endsWith('.dispatched') && ev.target && !decided.has(ev.target)) {
      decided.add(ev.target);
      if (!laterActors.has(ev.target) && ev.ms != null && now - ev.ms < WORK_WINDOW_MS) working.add(ev.target);
    }
    if (ev.actor) laterActors.add(ev.actor);
  }
  working.add(ALBERT_ID);
  return working;
}

// Fleet keeps its historical meaning: the ACTIVE store run's working set.
function computeWorking() {
  return computeRunWorking(state.activeRunId);
}

// GLOBAL working set: the union of every store run's and every session's working set,
// so a node is working when it was dispatched without a return ANYWHERE inside the
// work window. Both contributors keep their own staleness guards, so an idle run or a
// closed session adds nothing and nothing stays lit forever.
function globalWorking() {
  const working = new Set();
  for (const r of state.runs) {
    for (const name of computeRunWorking(r.id)) working.add(name);
  }
  const live = liveSessionEventIndex();
  for (const s of state.sessions) {
    for (const name of computeSessionWorking(s, live)) working.add(name);
  }
  return working;
}

// Snapshotted once at the top of updateGraph so the per-node chip closures and the
// tooltip read one consistent view rather than rebuilding the global index per node.
// The tooltip reads the snapshot rather than a value captured at build time, so its
// caller list stays current between rebuilds.
let currentGraphSeen = null;
let currentAgentIndex = null;
function graphSeenMs(name) {
  return currentGraphSeen ? currentGraphSeen.get(name) : undefined;
}

// agent -> newest activity ms, GLOBAL (max across every session and run). A.L.B.E.R.T.
// carries the newest sighting of any agent at all: the core is the box's heartbeat,
// not one run's.
function seenMapFrom(index) {
  const map = new Map();
  const albert = state.lastSeen.get(ALBERT_ID);
  let newest = albert == null ? null : albert;
  for (const [name, entry] of index) {
    if (entry.ms == null) continue;
    map.set(name, entry.ms);
    if (newest == null || entry.ms > newest) newest = entry.ms;
  }
  if (newest != null) map.set(ALBERT_ID, newest);
  return map;
}

// Hot set: a node is hot when its global most-recent activity is within HOT_MS.
// Reuses the same window store runs already use.
function hotSet(seen) {
  const hot = new Set();
  const now = Date.now();
  for (const [name, ms] of seen) {
    if (ms != null && now - ms < HOT_MS) hot.add(name);
  }
  return hot;
}

// The core lights whenever ANY session or run saw agent traffic this recently.
function isCoreActive(seen) {
  const ms = seen.get(ALBERT_ID);
  return ms != null && Date.now() - ms < ALBERT_ACTIVE_MS;
}

/* ---------------- graph node set ---------------- */

// Agents that appear as a party in an event feed, with their freshest timestamp.
// Actors are agents by definition; a target only names an agent on a dispatch (on
// other event types it is a task id, a branch, or the main session). `source` is the
// stream the events came from, so the tooltip can say who called the agent.
function collectFeedAgents(events, into, source) {
  for (const ev of events || []) {
    if (ev.ledger) continue; // synthesized rows guess the actor from a role string
    const actor = agentPartyName(canonAgent(ev.actor));
    if (actor) {
      bumpAgentEntry(into, actor, ev.ms, '', 0);
      bumpAgentSource(into, actor, source, ev.ms, 0);
    }
    if (typeof ev.type === 'string' && ev.type.endsWith('.dispatched')) {
      const target = agentPartyName(canonAgent(ev.target));
      if (target) {
        bumpAgentEntry(into, target, ev.ms, '', 0);
        // A store run has no summary to count dispatches for it, so its own events do.
        // Session dispatches are already counted by the session summary.
        bumpAgentSource(into, target, source, ev.ms, source && source.kind === 'run' ? 1 : 0);
      }
    }
  }
}

function bumpAgentEntry(map, name, ms, model, count) {
  const cur = map.get(name) || { name, ms: null, model: '', count: 0, sources: new Map() };
  if (ms != null && (cur.ms == null || ms > cur.ms)) {
    cur.ms = ms;
    if (model) cur.model = model; // freshest sighting wins the model badge
  }
  if (!cur.model && model) cur.model = model;
  if (count) cur.count += count;
  map.set(name, cur);
}

// Per-caller attribution for one agent type: which session (or store run) dispatched
// it, how often, and when it was last active there. Same merge rule as the entry
// totals: count SUMs, lastSeen takes the MAX.
function bumpAgentSource(map, name, source, ms, count) {
  if (!source || !source.id) return;
  const entry = map.get(name);
  if (!entry) return;
  const cur = entry.sources.get(source.id)
    || { kind: source.kind, id: source.id, label: '', count: 0, ms: null };
  if (source.label && !cur.label) cur.label = source.label;
  if (count) cur.count += count;
  if (ms != null && (cur.ms == null || ms > cur.ms)) cur.ms = ms;
  entry.sources.set(source.id, cur);
}

// Every event stream the graph reads: each store run's feed, then each session's own
// events (loaded history when present, live buffer otherwise). Newest-first within a
// stream, and one shared live index so a pass over every session stays cheap.
function eachEventStream(fn) {
  for (const [id, feed] of state.feeds) fn(feed, { kind: 'run', id, label: id });
  const live = liveSessionEventIndex();
  const covered = new Set();
  for (const s of state.sessions) {
    covered.add(s.session_id);
    fn(sessionEventsFor(s.session_id, live), { kind: 'session', id: s.session_id, label: sessionLabel(s) });
  }
  // A session whose summary has not landed yet still streams events.
  for (const [id, evs] of live) {
    if (!covered.has(id)) fn(evs, { kind: 'session', id, label: '' });
  }
}

/* ---------------- work items (what the agents are actually doing) ---------------- */

// The work text an event carries. Nothing new is read: a session dispatch summary is
// already "dispatched <agent>: <description>" and a return is "failed <agent>: <desc>
// (<status>)", while a store-run summary IS the description. Strip the route prefix and
// the trailing status so the panel shows the work rather than the plumbing.
function workDescription(ev) {
  const raw = String(ev.summary || '').trim();
  const m = /^(?:dispatched|completed|failed|done|started)\s+\S+\s*:\s*(.+)$/i.exec(raw);
  return (m ? m[1] : raw).replace(/\s*\([a-z_]+\)\s*$/, '').trim();
}

// Is this name an agent the console has actually observed? The other side of a harness
// event is just as often a branch, a task id or a user, and none of those are agents.
function isKnownAgent(name) {
  if (!name) return false;
  return isLoopAgent(name) || (currentAgentIndex ? currentAgentIndex.has(name) : false);
}

// Which agent an event is about, and whether it OPENS work (a dispatch) or closes it.
// A store run records completions as controller -> agent, so the agent is the target on
// both ends there; a session return is the agent reporting back as the actor.
function workAgent(ev) {
  if (String(ev.type || '').endsWith('.dispatched')) {
    return { name: agentPartyName(canonAgent(ev.target)), open: true };
  }
  const actor = agentPartyName(canonAgent(ev.actor));
  if (isKnownAgent(actor)) return { name: actor, open: false };
  // With the orchestrator as the actor the agent sits in the target slot, which on any
  // other event type holds a branch ("harness/...-chunk-b"), a task id or "user".
  const target = agentPartyName(canonAgent(ev.target));
  return { name: isKnownAgent(target) ? target : '', open: false };
}

// Newest-first work items across every stream the graph already unions. One row per
// distinct piece of work (stream + agent + description), so a dispatch and its matching
// return collapse into a single line. An item is RUNNING when its dispatch is the newest
// event for that agent in that stream, i.e. no later return, and is inside the work
// window - the same rule the node lighting uses, so nothing stays "running" forever.
function activityItems() {
  const rows = [];
  const seen = new Set();
  const now = Date.now();
  eachEventStream((events, source) => {
    const decided = new Set();
    let scanned = 0;
    for (const ev of events) { // newest first
      if (scanned >= ACTIVITY_SCAN) break;
      scanned++;
      if (ev.ledger) continue;
      const who = workAgent(ev);
      if (!who.name) continue;
      const newest = !decided.has(who.name);
      decided.add(who.name);
      const desc = workDescription(ev);
      if (!desc) continue;
      const key = (source ? source.id : '') + '|' + who.name + '|' + desc;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        agent: who.name,
        desc,
        source: source ? (source.label || (source.kind === 'session' ? String(source.id).slice(0, 8) : String(source.id))) : '',
        sourceId: source ? source.id : '',
        kind: source ? source.kind : '',
        ms: ev.ms,
        running: who.open && newest && ev.ms != null && now - ev.ms < WORK_WINDOW_MS,
      });
    }
  });
  rows.sort((a, b) => (b.ms == null ? -Infinity : b.ms) - (a.ms == null ? -Infinity : a.ms));
  return rows;
}

// GLOBAL agent index: agentType -> {name, ms, count, model, sources}, unioned across
// every session summary (authoritative counts + models) and every event stream on the
// box. lastSeen takes the MAX, counts SUM, the freshest sighting wins the model, and
// `sources` keeps the per-caller breakdown the tooltip renders.
function globalAgentIndex() {
  const out = new Map();
  for (const s of state.sessions) {
    const source = { kind: 'session', id: s.session_id, label: sessionLabel(s) };
    for (const a of s.agents) {
      const name = agentPartyName(a.agentType);
      if (!name) continue;
      const ms = tsMs(a.lastSeen);
      bumpAgentEntry(out, name, ms, a.model, a.count);
      bumpAgentSource(out, name, source, ms, a.count);
    }
  }
  eachEventStream((events, source) => collectFeedAgents(events, out, source));
  return out;
}

// A node's group decides its ring and its palette: loop-* agents are the cyan harness
// roster, everything else (general-purpose, Explore, code-reviewer, ... and any type
// this build has never heard of) is a violet session agent.
function nodeFor(name, entry) {
  const roster = state.byName.get(name);
  const isLoop = !!roster || name.indexOf('loop-') === 0;
  return {
    name,
    group: isLoop ? 'loop' : 'ambient',
    // An unrostered loop-* agent has no declared class; maintainers is the existing
    // catch-all bucket, so it lands there rather than vanishing.
    class: roster ? (roster.class || '') : (isLoop ? '' : 'session'),
    role: roster ? (roster.role || '') : sessionAgentRole(entry),
    model: (roster && roster.model) || (entry && entry.model) || '',
    count: entry ? entry.count : 0,
  };
}

function sessionAgentRole(entry) {
  return entry && entry.count ? 'SESSION AGENT :: x' + entry.count : 'SESSION AGENT';
}

// Same test nodeFor() uses to pick a palette, hoisted so the node set can bucket a
// name before building a node for it.
function isLoopAgent(name) {
  return state.byName.has(name) || name.indexOf('loop-') === 0;
}

// The graph's node set, GLOBAL and complete: the canonical loop-* roster (harness
// structure, drawn whether or not it ran) plus any other loop-* agent observed anywhere,
// plus EVERY ambient agent type ever seen in any session or run, however old. No focus,
// no per-run filtering, no age or count culling - the band grows and the layout absorbs it.
function graphAgentNodes(index) {
  const idx = index || globalAgentIndex();
  const loop = [];
  const taken = new Set();
  const addLoop = (name) => {
    if (!name || taken.has(name)) return;
    taken.add(name);
    loop.push(nodeFor(name, idx.get(name)));
  };
  for (const a of state.roster) {
    if (a.class === 'orchestrator' || canonAgent(a.name) === ALBERT_ID) continue;
    addLoop(a.name);
  }
  const ambient = [];
  for (const [name, entry] of idx) {
    if (taken.has(name)) continue;
    if (isLoopAgent(name)) { addLoop(name); continue; }
    taken.add(name);
    ambient.push(entry);
  }
  // Busiest session agents first, so the front of the AGENTS arc is the ones that matter.
  ambient.sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));
  return loop.concat(ambient.map((e) => nodeFor(e.name, e)));
}

/* ---------------- roster / runs ingest ---------------- */

function applyRoster(list) {
  const agents = Array.isArray(list) ? list.slice() : [];
  if (!agents.some((a) => a && a.name === ALBERT_ID)) {
    agents.unshift({ name: ALBERT_ID, class: 'orchestrator', role: 'Agentic Loop Broker for Execution, Reasoning & Tasking', model: 'session', tools: [] });
  }
  state.roster = agents.filter((a) => a && a.name);
  state.byName = new Map(state.roster.map((a) => [a.name, a]));
}

function applyRuns(payload) {
  if (!payload) return;
  state.activeRunId = payload.active_run_id || null;
  state.runs = Array.isArray(payload.runs) ? payload.runs : [];
  if (!state.commsRunId || !state.runs.some((r) => r.id === state.commsRunId)) {
    state.commsRunId = state.activeRunId || (state.runs[0] && state.runs[0].id) || null;
  }
  if (!state.sessionsSel || !state.runs.some((r) => r.id === state.sessionsSel)) {
    state.sessionsSel = state.activeRunId || (state.runs[0] && state.runs[0].id) || null;
  }
}

async function ensureDetail(runId) {
  if (!runId) return null;
  if (state.details.has(runId)) return state.details.get(runId);
  const detail = await fetchJSON('/api/runs/' + encodeURIComponent(runId));
  state.details.set(runId, detail);
  setFeed(runId, detail);
  return detail;
}

/* ---------------- pills / badges ---------------- */

function pillFor(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'running') return ['RUNNING', 'p-run'];
  if (s === 'checkpoint') return ['CHECKPOINT', 'p-gold'];
  if (s === 'done' || s === 'complete' || s === 'completed' || s === 'merged') return [s.toUpperCase(), 'p-ok'];
  if (s === 'failed' || s === 'error' || s === 'stopped' || s === 'aborted') return [s.toUpperCase(), 'p-err'];
  if (!s) return ['UNKNOWN', 'p-dim'];
  return [s.toUpperCase(), 'p-dim'];
}

function makePill(status) {
  const [label, cls] = pillFor(status);
  return el('span', 'pill ' + cls, label);
}

function modelBadge(model) {
  const m = String(model || '').toLowerCase();
  let cls = 'm-dim', label = (model || '?').toUpperCase();
  if (m.includes('opus')) { cls = 'm-opus'; label = 'OPUS'; }
  else if (m.includes('sonnet')) { cls = 'm-sonnet'; label = 'SONNET'; }
  else if (m.includes('haiku')) { cls = 'm-haiku'; label = 'HAIKU'; }
  else if (m.includes('session')) { cls = 'm-session'; label = 'SESSION'; }
  return el('span', 'model-badge ' + cls, label);
}

function emptyState(text) {
  const box = el('div', 'empty');
  box.appendChild(el('span', 'empty-tick', '['));
  box.appendChild(el('span', 'empty-text', text));
  box.appendChild(el('span', 'empty-tick', ']'));
  return box;
}

function addCorners(node) {
  const c = el('i', 'c4');
  c.setAttribute('aria-hidden', 'true');
  node.appendChild(c);
  return node;
}

/* ---------------- glyphs (inline SVG, hand-rolled) ---------------- */

// Shapes drawn in a -10..10 box centered at origin; caller positions/scales the group.
function classGlyph(cls) {
  const g = svg('g', { class: 'glyph' });
  if (cls === 'orchestrator') {
    g.appendChild(svg('circle', { r: 5, fill: 'none' }));
    g.appendChild(svg('line', { x1: 0, y1: -9, x2: 0, y2: -5 }));
    g.appendChild(svg('line', { x1: 0, y1: 5, x2: 0, y2: 9 }));
    g.appendChild(svg('line', { x1: -9, y1: 0, x2: -5, y2: 0 }));
    g.appendChild(svg('line', { x1: 5, y1: 0, x2: 9, y2: 0 }));
    g.appendChild(svg('circle', { r: 1.3, class: 'fill' }));
  } else if (cls === 'planner') {
    g.appendChild(svg('path', { d: 'M0 -8 L8 6 L-8 6 Z', fill: 'none' }));
    g.appendChild(svg('circle', { cx: 0, cy: -8, r: 1.6, class: 'fill' }));
    g.appendChild(svg('circle', { cx: 8, cy: 6, r: 1.6, class: 'fill' }));
    g.appendChild(svg('circle', { cx: -8, cy: 6, r: 1.6, class: 'fill' }));
  } else if (cls === 'producer') {
    g.appendChild(svg('path', { d: 'M2 -9 L-6 2 L-1 2 L-2 9 L6 -2 L1 -2 Z', class: 'fill', stroke: 'none' }));
  } else if (cls === 'critic') {
    g.appendChild(svg('path', { d: 'M-8 0 Q0 -7 8 0 Q0 7 -8 0 Z', fill: 'none' }));
    g.appendChild(svg('circle', { r: 2.4, class: 'fill' }));
  } else { // maintainer
    g.appendChild(svg('circle', { r: 4, fill: 'none' }));
    for (let i = 0; i < 6; i++) {
      const a = (i * 60) * Math.PI / 180;
      g.appendChild(svg('line', {
        x1: (Math.cos(a) * 5.5).toFixed(2), y1: (Math.sin(a) * 5.5).toFixed(2),
        x2: (Math.cos(a) * 8).toFixed(2), y2: (Math.sin(a) * 8).toFixed(2),
      }));
    }
  }
  return g;
}

// Ambient (session) agents get their own mark: a broken orbit around a soft node,
// deliberately unlike the five harness class glyphs.
function ambientGlyph() {
  const g = svg('g', { class: 'glyph glyph-amb' });
  g.appendChild(svg('circle', { r: 8, fill: 'none', 'stroke-dasharray': '2 3' }));
  g.appendChild(svg('circle', { r: 3.2, class: 'fill' }));
  g.appendChild(svg('line', { x1: -8, y1: 0, x2: -3.2, y2: 0 }));
  g.appendChild(svg('line', { x1: 3.2, y1: 0, x2: 8, y2: 0 }));
  return g;
}

/* ---------------- plan + local burn (topbar readout) ---------------- */

const USAGE_POLL_MS = 60 * 1000;

// THIS IS NOT THE ANTHROPIC PLAN PERCENTAGE. There is no readable source for that (the
// claude.ai endpoint is behind bot protection and the Admin API does not cover
// individual subscriptions), so the strip shows the plan LABEL from the Claude Code
// CLI plus tokens measured locally from transcripts. Every label and tooltip here says
// so, because a bare percentage-looking number would be read as quota.
function burnTone(tokens, busiest) {
  if (!busiest || !tokens) return 'u-ok';
  const share = tokens / busiest;
  if (share >= 1) return 'u-crit';
  if (share >= 0.75) return 'u-warn';
  return 'u-ok';
}

function usageItem(label, valueText, opts) {
  const o = opts || {};
  const item = el('span', 'usage-item ' + (o.tone || 'u-ok'));
  if (o.title) item.title = o.title;
  item.appendChild(el('span', 'usage-label', label));
  if (o.fraction != null) {
    const bar = el('span', 'usage-bar');
    const fill = el('i', 'usage-fill');
    fill.style.transform = 'scaleX(' + Math.max(0, Math.min(1, o.fraction)).toFixed(3) + ')';
    bar.appendChild(fill);
    item.appendChild(bar);
  }
  item.appendChild(el('span', 'usage-pct num', valueText));
  return item;
}

function ensureUsageWrap() {
  const existing = $('#usageWrap');
  if (existing) return existing;
  const bar = $('#topbar');
  const runTag = $('#runTag');
  if (!bar || !runTag) return null;
  const wrap = el('div', 'usage-wrap');
  wrap.id = 'usageWrap';
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-label', 'Plan and local token burn');
  // Inserted before the run tag, which keeps its margin-left:auto, so no existing
  // topbar element moves.
  bar.insertBefore(wrap, runTag);
  return wrap;
}

// The tooltip carries the honesty: what these numbers are, what they are not, and the
// breakdown behind them.
function burnTooltip(burn) {
  const lines = ['LOCAL BURN (rolling 7d), measured from transcripts on this box',
    'not the Anthropic plan quota, and this window does not match the plan reset'];
  lines.push('today ' + fmtCompact(burn.today_tokens) + ' :: week ' + fmtCompact(burn.week_tokens)
    + ' :: input + output + cache writes');
  lines.push('cache reads (excluded) week ' + fmtCompact(burn.week_cache_read_tokens));
  if (burn.by_project.length) {
    lines.push('projects: ' + burn.by_project.map((p) => p.name + ' ' + fmtCompact(p.tokens)).join(', '));
  }
  if (burn.by_agent.length) {
    lines.push('agents: ' + burn.by_agent.map((a) => a.agentType + ' ' + fmtCompact(a.tokens)).join(', '));
  }
  for (const s of burn.top_sessions) {
    lines.push('  ' + fmtCompact(s.tokens).padStart(7) + '  ' + (s.title || s.session_id.slice(0, 8)));
  }
  return lines.join('\n');
}

function renderUsage() {
  const wrap = ensureUsageWrap();
  if (!wrap) return;
  wrap.textContent = '';
  const u = state.usage;
  if (!u) return;                       // nothing fetched yet: stay out of the way
  if (u.plan) {
    const chip = usageItem('PLAN', u.plan.label, {
      title: 'Claude Code reports this subscription' + (u.plan.orgName ? ' :: ' + u.plan.orgName : ''),
    });
    chip.classList.add('usage-plan');
    wrap.appendChild(chip);
  }
  const burn = u.burn;
  if (!burn || (!burn.today_tokens && !burn.week_tokens)) {
    wrap.appendChild(el('span', 'usage-note', 'NO LOCAL BURN YET'));
    return;
  }
  const tip = burnTooltip(burn);
  wrap.appendChild(usageItem('TODAY', fmtCompact(burn.today_tokens), {
    title: tip,
    tone: burnTone(burn.today_tokens, burn.busiest_day_tokens),
    // Against the busiest day in the window: the only honest denominator we have.
    fraction: burn.busiest_day_tokens ? burn.today_tokens / burn.busiest_day_tokens : 0,
  }));
  wrap.appendChild(usageItem('WEEK', fmtCompact(burn.week_tokens), { title: tip }));
}

// Field-by-field rebuild, like every other payload this file ingests: numbers, a plan
// word and short labels. No credential could reach here, and none would survive this.
function normUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  const b = raw.burn && typeof raw.burn === 'object' ? raw.burn : {};
  const list = (arr, key) => (Array.isArray(arr) ? arr.slice(0, 6) : [])
    .filter((r) => r && typeof r === 'object' && r[key])
    .map((r) => ({ [key]: esc(r[key]), tokens: n(r.tokens) }));
  return {
    plan: raw.plan && typeof raw.plan === 'object' && raw.plan.label
      ? { label: esc(raw.plan.label), orgName: esc(raw.plan.orgName || '') }
      : null,
    burn: {
      today_tokens: n(b.today_tokens),
      week_tokens: n(b.week_tokens),
      today_cache_read_tokens: n(b.today_cache_read_tokens),
      week_cache_read_tokens: n(b.week_cache_read_tokens),
      busiest_day_tokens: n(b.busiest_day_tokens),
      by_project: list(b.by_project, 'name'),
      by_agent: list(b.by_agent, 'agentType'),
      top_sessions: (Array.isArray(b.top_sessions) ? b.top_sessions.slice(0, 5) : [])
        .filter((s) => s && typeof s === 'object' && s.session_id)
        .map((s) => ({ session_id: esc(s.session_id), title: esc(s.title || ''), tokens: n(s.tokens) })),
    },
  };
}

async function fetchUsage() {
  try {
    state.usage = normUsage(await fetchJSON('/api/usage'));
  } catch (e) {
    // Endpoint absent or unreachable: leave the last good readout in place.
    return;
  }
  renderUsage();
}

/* ---------------- topbar ---------------- */

function renderTopbar() {
  const dot = $('#liveDot');
  const label = $('#liveLabel');
  dot.className = state.connected ? 'on' : 'off';
  label.textContent = state.connected ? 'LIVE' : 'OFFLINE';
  label.className = state.connected ? 'lbl-on' : 'lbl-off';
  const tag = $('#runTag');
  if (state.activeRunId) {
    const run = state.runs.find((r) => r.id === state.activeRunId);
    tag.textContent = state.activeRunId + (run && run.project ? ' :: ' + run.project : '');
  } else {
    tag.textContent = 'NO ACTIVE RUN';
  }
}

/* ---------------- FLEET ---------------- */

function agentCard(agent, isWorking) {
  const card = addCorners(el('article', 'agent-card panel' + (isWorking ? ' working' : '')));
  card.dataset.agent = agent.name;

  const emblem = svg('svg', { class: 'emblem', viewBox: '0 0 64 64', 'aria-hidden': 'true' });
  emblem.appendChild(svg('circle', { cx: 32, cy: 32, r: 28, class: 'emb-ring', fill: 'none' }));
  emblem.appendChild(svg('circle', { cx: 32, cy: 32, r: 22, class: 'emb-dash rot-slow', fill: 'none', 'stroke-dasharray': '3 5' }));
  const gg = classGlyph(agent.class);
  gg.setAttribute('transform', 'translate(32 32)');
  emblem.appendChild(gg);
  card.appendChild(emblem);

  const body = el('div', 'agent-body');
  body.appendChild(el('h3', 'agent-name', canonAgent(agent.name) === ALBERT_ID ? 'A.L.B.E.R.T.' : agent.name.toUpperCase()));
  body.appendChild(el('p', 'agent-role', agent.role || ''));

  const meta = el('div', 'agent-meta');
  meta.appendChild(el('span', 'status-pill ' + (isWorking ? 'sp-work' : 'sp-idle'), isWorking ? 'WORKING' : 'IDLE'));
  const hb = el('span', 'hb num', fmtRel(state.lastSeen.get(agent.name)));
  hb.dataset.hb = agent.name;
  meta.appendChild(el('span', 'hb-label', 'HB'));
  meta.appendChild(hb);
  meta.appendChild(modelBadge(agent.model));
  body.appendChild(meta);
  card.appendChild(body);
  return card;
}

// Agent types observed in Claude Code sessions that the harness roster does not own.
// Roster members and A.L.B.E.R.T. (any alias) are filtered out so the harness sections
// stay canonical.
function ambientAgents() {
  const by = new Map();
  for (const s of state.sessions) {
    for (const a of s.agents) {
      const type = a.agentType;
      if (!type || canonAgent(type) === ALBERT_ID || state.byName.has(type)) continue;
      const cur = by.get(type) || { agentType: type, count: 0, ms: null, model: '' };
      cur.count += a.count;
      const ms = tsMs(a.lastSeen);
      if (ms != null && (cur.ms == null || ms > cur.ms)) {
        cur.ms = ms;
        if (a.model) cur.model = a.model; // freshest sighting wins the model badge
      }
      if (!cur.model && a.model) cur.model = a.model;
      by.set(type, cur);
    }
  }
  return Array.from(by.values())
    .sort((a, b) => (b.count - a.count) || a.agentType.localeCompare(b.agentType));
}

function ambientCard(a) {
  const card = addCorners(el('article', 'agent-card amb-card panel'));
  card.dataset.ambient = a.agentType;

  const emblem = svg('svg', { class: 'emblem', viewBox: '0 0 64 64', 'aria-hidden': 'true' });
  emblem.appendChild(svg('circle', { cx: 32, cy: 32, r: 28, class: 'emb-ring', fill: 'none' }));
  emblem.appendChild(svg('circle', { cx: 32, cy: 32, r: 22, class: 'emb-dash rot-slow', fill: 'none', 'stroke-dasharray': '3 5' }));
  const gg = ambientGlyph();
  gg.setAttribute('transform', 'translate(32 32) scale(1.15)');
  emblem.appendChild(gg);
  card.appendChild(emblem);

  const body = el('div', 'agent-body');
  body.appendChild(el('h3', 'agent-name', a.agentType.toUpperCase()));
  body.appendChild(el('p', 'agent-role amb-role', 'SESSION AGENT'));

  const meta = el('div', 'agent-meta');
  const cb = el('span', 'count-badge num', 'x' + a.count);
  cb.title = a.count + ' dispatches seen';
  meta.appendChild(cb);
  meta.appendChild(el('span', 'hb-label', 'HB'));
  const hb = el('span', 'hb amb-hb num', fmtRel(state.sessionSeen.get(a.agentType)));
  hb.dataset.ahb = a.agentType;
  meta.appendChild(hb);
  meta.appendChild(modelBadge(a.model || '-'));
  body.appendChild(meta);
  card.appendChild(body);
  return card;
}

function fleetHeading(label) {
  const h = el('h2', 'section-title');
  h.appendChild(el('span', 'title-tick', '//'));
  h.appendChild(el('span', null, ' ' + label));
  return h;
}

function renderFleet() {
  const root = $('#view-fleet');
  root.textContent = '';
  if (!state.roster.length) {
    root.appendChild(emptyState('AWAITING ROSTER'));
    return;
  }
  const working = computeWorking();
  for (const cls of CLASS_ORDER) {
    const agents = state.roster.filter((a) => a.class === cls);
    if (!agents.length) continue;
    const sec = el('section', 'fleet-section');
    sec.appendChild(fleetHeading(CLASS_LABEL[cls]));
    const grid = el('div', 'fleet-grid');
    for (const a of agents) grid.appendChild(agentCard(a, working.has(a.name)));
    sec.appendChild(grid);
    root.appendChild(sec);
  }
  const ambient = ambientAgents();
  if (ambient.length) {
    const sec = el('section', 'fleet-section amb-section');
    sec.appendChild(fleetHeading('AMBIENT'));
    const grid = el('div', 'fleet-grid');
    for (const a of ambient) grid.appendChild(ambientCard(a));
    sec.appendChild(grid);
    root.appendChild(sec);
  }
}

function patchFleet() {
  const working = computeWorking();
  // Harness cards only: ambient cards have no working state and read a different map.
  for (const card of $$('.agent-card:not(.amb-card)')) {
    const name = card.dataset.agent;
    const isW = working.has(name);
    card.classList.toggle('working', isW);
    const pill = $('.status-pill', card);
    if (pill) {
      pill.textContent = isW ? 'WORKING' : 'IDLE';
      pill.className = 'status-pill ' + (isW ? 'sp-work' : 'sp-idle');
    }
    const hb = $('[data-hb]', card);
    if (hb) hb.textContent = fmtRel(state.lastSeen.get(name));
  }
  for (const hb of $$('[data-ahb]')) {
    hb.textContent = fmtRel(state.sessionSeen.get(hb.dataset.ahb));
  }
}

/* ---------------- COMMS ---------------- */

function chip(label, active, onClick) {
  const b = el('button', 'chip' + (active ? ' active' : ''), label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function renderCommsChips() {
  const wrap = $('#commsChips');
  wrap.textContent = '';
  for (const [id, label] of FILTER_CHIPS) {
    wrap.appendChild(chip(label, state.commsFilter === id, () => {
      state.commsFilter = id;
      renderComms();
    }));
  }
  if (state.commsAgent) {
    const c = chip('AGENT: ' + state.commsAgent.toUpperCase() + '  x', true, () => {
      state.commsAgent = null;
      renderComms();
    });
    c.classList.add('chip-agent');
    c.setAttribute('aria-label', 'Clear agent filter ' + state.commsAgent);
    wrap.appendChild(c);
  }
  if (state.runs.length > 1) {
    const selWrap = el('label', 'run-select-wrap');
    selWrap.appendChild(el('span', 'run-select-label', 'RUN'));
    const sel = el('select', 'run-select');
    sel.setAttribute('aria-label', 'Select run for feed');
    for (const r of state.runs) {
      const opt = el('option', null, r.id);
      opt.value = r.id;
      if (r.id === state.commsRunId) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => {
      state.commsRunId = sel.value;
      ensureDetail(sel.value).then(renderComms).catch(renderComms);
    });
    selWrap.appendChild(sel);
    wrap.appendChild(selWrap);
  }
}

function feedRow(ev) {
  const row = el('div', 'feed-row');
  const [blabel, bcls] = badgeFor(ev);
  row.appendChild(el('span', 'badge ' + bcls, blabel));

  const route = el('span', 'route');
  route.appendChild(el('span', 'actor', ev.actor ? (canonAgent(ev.actor) === ALBERT_ID ? 'A.L.B.E.R.T.' : ev.actor) : '-'));
  route.appendChild(el('span', 'arrow', ' -> '));
  let tcls = 'target';
  if (ev.isSession) {
    // Session agent types are not roster members; mark them violet, not harness gold.
    if (ev.target && ev.target !== SESSION_MAIN_ACTOR) tcls += ' is-sagent';
  } else if (state.byName.has(ev.target)) {
    tcls += ' is-agent';
  }
  route.appendChild(el('span', tcls, ev.target ? (canonAgent(ev.target) === ALBERT_ID ? 'A.L.B.E.R.T.' : ev.target) : '-'));
  row.appendChild(route);

  if (ev.iteration != null && Number.isFinite(Number(ev.iteration))) {
    row.appendChild(el('span', 'iter-tag num', 'i' + ev.iteration));
  }

  const sum = el('span', 'summary', ev.summary);
  sum.title = ev.summary;
  row.appendChild(sum);

  const rel = el('span', 'rel num', fmtRel(ev.ms));
  if (ev.ms != null) rel.dataset.ts = String(ev.ms);
  row.appendChild(rel);
  return row;
}

function passesCommsFilters(ev) {
  if (state.commsFilter !== 'all' && filterCat(ev) !== state.commsFilter) return false;
  if (state.commsAgent && canonAgent(ev.actor) !== state.commsAgent && canonAgent(ev.target) !== state.commsAgent) return false;
  return true;
}

// Identity of a session event across the two buffers it can arrive in (the live
// page-load feed and a loaded session detail), so the merge does not double it.
function commsEventKey(ev) {
  return ev.session_id + '|' + (ev.ms == null ? '' : ev.ms) + '|' + ev.type + '|' + ev.actor + '|' + ev.target;
}

// The feed shows the selected run's harness telemetry merged with Claude Code
// session events, which are not run-scoped. Interleaved by timestamp, newest first;
// undated rows (synthesized ledger lines) sink to the bottom keeping their order.
// state.sessionFeed only covers the current page load, so every loaded session history
// joins the merge too: the graph is global, so a node click on an agent last seen days
// ago would otherwise land on an empty feed.
function mergedCommsFeed() {
  const runFeed = state.feeds.get(state.commsRunId) || [];
  const seen = new Set();
  const sessionFeed = [];
  const take = (ev) => {
    const k = commsEventKey(ev);
    if (seen.has(k)) return;
    seen.add(k);
    sessionFeed.push(ev);
  };
  for (const detail of state.sessionDetails.values()) {
    for (const ev of (detail && detail.events) || []) take(ev);
  }
  for (const ev of state.sessionFeed) take(ev);
  if (!sessionFeed.length) return runFeed;
  return runFeed.concat(sessionFeed)
    .map((ev, i) => [ev, i])
    .sort((a, b) => {
      const am = a[0].ms, bm = b[0].ms;
      if (am == null && bm == null) return a[1] - b[1];
      if (am == null) return 1;
      if (bm == null) return -1;
      return bm === am ? a[1] - b[1] : bm - am;
    })
    .map((pair) => pair[0]);
}

function renderComms() {
  renderCommsChips();
  const feedBox = $('#commsFeed');
  feedBox.textContent = '';
  addCorners(feedBox);
  const feed = mergedCommsFeed();
  const rows = feed.filter(passesCommsFilters).slice(0, FEED_DOM_CAP);
  if (!rows.length) {
    feedBox.appendChild(emptyState(feed.length ? 'NO MATCHING TELEMETRY' : 'AWAITING TELEMETRY'));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const ev of rows) frag.appendChild(feedRow(ev));
  feedBox.appendChild(frag);
}

// Live-event path: patch the feed DOM in place instead of a full rebuild so the
// reader's scroll position survives and the chips / run select are not destroyed.
function prependLiveRow(ev) {
  const feedBox = $('#commsFeed');
  const emptyBox = $('.empty', feedBox);
  if (!passesCommsFilters(ev)) {
    // The feed is non-empty now, so an empty placeholder means "filtered out".
    const t = emptyBox ? $('.empty-text', emptyBox) : null;
    if (t) t.textContent = 'NO MATCHING TELEMETRY';
    return;
  }
  if (emptyBox) emptyBox.remove();
  const row = feedRow(ev);
  const first = $('.feed-row', feedBox);
  if (first) feedBox.insertBefore(row, first);
  else feedBox.appendChild(row);
  const rows = $$('.feed-row', feedBox);
  for (let i = FEED_DOM_CAP; i < rows.length; i++) rows[i].remove();
  // overflow-anchor is off on #commsFeed; compensate manually so a reader
  // scrolled into older telemetry is not shifted by the inserted row.
  if (feedBox.scrollTop > 0) feedBox.scrollTop += row.offsetHeight;
}

// state.sessions is newest first, so the first session that used this agent type is
// also the freshest one.
function newestSessionWithAgent(agentName) {
  if (!agentName) return null;
  for (const s of state.sessions) {
    for (const a of s.agents) {
      if (agentPartyName(a.agentType) === agentName) return s.session_id;
    }
  }
  return null;
}

// Graph node click: filter COMMS to that agent, globally. Nothing is pinned and the
// run selector is left exactly as the reader set it. The agent's traffic may predate
// this page load, so the newest session that used it is pulled in (mergedCommsFeed
// folds every loaded history in) rather than landing the reader on an empty feed.
function gotoComms(agentName) {
  state.commsAgent = agentName;
  state.commsFilter = 'all';
  const sid = newestSessionWithAgent(agentName);
  if (sid && !state.sessionDetails.has(sid)) {
    ensureSessionDetail(sid)
      .then(() => { if (state.view === 'comms') renderComms(); })
      .catch(() => {});
  }
  setView('comms');
}

/* ---------------- GRAPH ---------------- */

const HEX_R = 34;
const GRAPH_WIDE_MIN = 1100;  // below this viewport width, labels drop under the hexes
const CHIP_CH = 7;            // approx mono glyph advance at 10px; sizes svg chip rects
const NAME_CH = 10.8;         // 14px mono advance + 0.16em tracking
const CLASS_CH = 8.5;         // 10px mono advance + 0.24em tracking
const LABEL_DROP = 63;        // label stack height below a hex centre in 'down' mode
const GRAPH_PAD = 40;         // viewBox breathing room around the drawn extent
const CLEAR_TARGET = 28;      // wanted gap between any two label boxes
const CLEAR_FLOOR = 20;       // below this the field expands rather than packing tighter
const DRIFT_MAX = 7;          // drift amplitude ceiling; stays under CLEAR_FLOOR / 2
const RELAX_PASSES = 90;
const EXPAND_TRIES = 4;
const ZONE_GAP_DEG = 7;       // dead arc between neighbouring zones

function polar(cx, cy, r, deg) {
  const a = deg * Math.PI / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

// Flat-top hexagon path centered at the origin.
function hexPath(r) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const [x, y] = polar(0, 0, r, i * 60);
    pts.push(x.toFixed(1) + ' ' + y.toFixed(1));
  }
  return 'M' + pts.join(' L') + ' Z';
}

// Two layout modes. Wide runs a broad elliptical field with label blocks fanning out
// beside the outer hexes; narrow squeezes the field vertically and drops every label
// under its hex. W/H seed the frame only: the viewBox is fitted to the drawn extent, so
// a crowded field grows the canvas instead of packing nodes on top of each other.
// ax/ay stretch the field into the panel's own aspect, which is what stops the mid-left
// and mid-right of a wide panel from sitting empty while the middle is jammed.
function graphLayout() {
  const wide = window.innerWidth >= GRAPH_WIDE_MIN;
  // ax/ay are tuned to the box the ACTIVITY dock leaves behind (a left gutter when
  // wide, a bottom dock when narrow), so the field fills that box instead of being
  // letterboxed inside it with the labels shrinking for nothing.
  return wide
    ? { wide, W: 1600, H: 1000, coreX: 800, coreY: 520, coreR: 95, ax: 1.4, ay: 1 }
    : { wide, W: 1000, H: 1240, coreX: 500, coreY: 620, coreR: 88, ax: 1, ay: 1.2 };
}

/* ---------------- the agent field: zones, clearance, drift ---------------- */

// Deterministic per-name pseudo-random in [0,1) (FNV-1a). Jitter and drift phase have
// to be stable across rebuilds or the whole field would reshuffle on every new agent
// type, so Math.random is not an option here.
function hashUnit(name, salt) {
  const s = String(name) + '#' + salt;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

// Angles are degrees clockwise from east, so 270 is straight up (svg y grows downward).
function toXY(L, deg, r) {
  const a = deg * Math.PI / 180;
  return [L.coreX + Math.cos(a) * r * L.ax, L.coreY + Math.sin(a) * r * L.ay];
}

function toPolar(L, x, y) {
  const u = (x - L.coreX) / L.ax;
  const v = (y - L.coreY) / L.ay;
  return { deg: Math.atan2(v, u) * 180 / Math.PI, r: Math.hypot(u, v) };
}

// Arc length per radian at this bearing on the stretched field, so ring packing spaces
// nodes by real distance rather than by raw angle.
function arcScale(L, deg) {
  const a = deg * Math.PI / 180;
  return Math.hypot(L.ax * Math.sin(a), L.ay * Math.cos(a));
}

// The core plus its own labels, as an immovable obstacle.
function coreBox(L) {
  return [L.coreX - L.coreR - 30, L.coreY - L.coreR - 30, L.coreX + L.coreR + 30, L.coreY + L.coreR + 74];
}

// Minimum distance between two label boxes; negative when they overlap.
function boxClearance(a, b) {
  const dx = Math.max(a[0] - b[2], b[0] - a[2]);
  const dy = Math.max(a[1] - b[3], b[1] - a[3]);
  if (dx >= 0 && dy >= 0) return Math.hypot(dx, dy);
  return Math.max(dx, dy);
}

function boxCenter(b) { return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; }

// Unit vector pointing from box b towards box a, with a stable fallback when the two
// centres coincide.
function pushDir(a, b) {
  const [ax, ay] = boxCenter(a);
  const [bx, by] = boxCenter(b);
  const dx = ax - bx, dy = ay - by;
  const d = Math.hypot(dx, dy);
  if (d < 0.001) return [1, 0];
  return [dx / d, dy / d];
}

// Zone membership. Unknown loop classes ride with the maintainers, exactly as the old
// column layout did, so nothing can silently vanish.
function zoneOf(node) {
  if (node.group === 'ambient') return 'ambient';
  if (node.class === 'planner' || node.class === 'producer' || node.class === 'critic') return node.class;
  return 'maintainer';
}

const ZONE_ORDER = ['producer', 'planner', 'critic', 'maintainer'];
const ZONE_CAPTION = {
  producer: '// PRODUCERS', planner: '// PLANNER', critic: '// CRITICS',
  maintainer: '// MAINTAINERS', ambient: '// AGENTS',
};

// Angular sectors. The harness roster owns the upper arc (producers west, planner at the
// apex, then critics and maintainers east), each class taking a share proportional to
// its population so a crowded class gets more arc rather than more rings. The ambient
// band owns the whole lower ~190 degrees; with no roster it takes the full circle.
function zoneSectors(byZone) {
  const sectors = {};
  const ambient = byZone.ambient ? byZone.ambient.length : 0;
  const keys = ZONE_ORDER.filter((k) => byZone[k] && byZone[k].length);
  if (ambient) sectors.ambient = keys.length ? [354, 546] : [0, 360];
  if (!keys.length) return sectors;
  const from = 186;
  const to = ambient ? 354 : 546;
  const span = (to - from) - ZONE_GAP_DEG * (keys.length - 1);
  // The +0.6 keeps a one-node class from collapsing into a slit it cannot breathe in.
  const weights = keys.map((k) => byZone[k].length + 0.6);
  const total = weights.reduce((a, b) => a + b, 0);
  let cur = from;
  keys.forEach((k, i) => {
    const w = span * (weights[i] / total);
    sectors[k] = [cur, cur + w];
    cur += w + ZONE_GAP_DEG;
  });
  return sectors;
}

// Footprint of a node along the arc. A label under the hex is cheap radially (the stack
// is 2*HEX_R + LABEL_DROP deep, which is what sets the ring pitch) but expensive along
// the arc; a label beside the hex is the other way round.
function tangentialSpan(node, side) {
  return side === 'down' ? Math.max(2 * HEX_R, nodeLabelWidth(node)) : 2 * HEX_R + 26;
}

// Labels fan outward on the outermost ring of a zone, where nothing sits beyond them to
// be pushed away; inner rings keep their labels under the hex so the next ring can sit
// close. Narrow mode is always under-the-hex: side labels would blow out the width.
function pickSide(L, deg, outermost) {
  if (!L.wide || !outermost) return 'down';
  const c = Math.cos(deg * Math.PI / 180);
  if (c > 0.45) return 'right';
  if (c < -0.45) return 'left';
  return 'down';
}

// Pack one zone into rings inside its sector: a ring takes as many nodes as its arc can
// clear and the rest spill outward, so a crowded zone grows radially and never squeezes
// its labels together. Positions are jittered from the name hash so the result reads as
// a floating cluster rather than a rigid arc.
function packZone(list, sector, L, rMin) {
  const step = 2 * HEX_R + LABEL_DROP + CLEAR_TARGET;
  const spanDeg = sector[1] - sector[0];
  const out = [];
  let i = 0;
  let ring = 0;
  while (i < list.length) {
    const r = rMin + ring * step;
    const cells = [];
    let used = 0;
    while (i < list.length) {
      const arc = Math.max(1, r * arcScale(L, sector[0] + used + 1));
      const need = Math.min(spanDeg, (tangentialSpan(list[i], 'down') + CLEAR_TARGET) / arc * (180 / Math.PI));
      if (cells.length && used + need > spanDeg) break;
      cells.push({ node: list[i], deg: need });
      used += need;
      i++;
    }
    let cursor = sector[0] + Math.max(0, spanDeg - used) / 2;
    for (const c of cells) {
      const jitterDeg = (hashUnit(c.node.name, 'arc') - 0.5) * c.deg * 0.34;
      const jitterR = (hashUnit(c.node.name, 'rad') - 0.5) * step * 0.26;
      out.push({ node: c.node, deg: cursor + c.deg / 2 + jitterDeg, r: r + jitterR, ring });
      cursor += c.deg;
    }
    ring++;
  }
  return { placed: out, rings: ring };
}

// Keep a node inside its own sector while leaving it free to float outward: when a zone
// runs out of arc the push-apart pass turns into radial expansion instead of crowding.
function movePlaced(p, x, y, sector, L, rMin) {
  const pol = toPolar(L, x, y);
  let deg = pol.deg;
  if (sector) {
    while (deg < sector[0]) deg += 360;
    while (deg >= sector[0] + 360) deg -= 360;
    const pad = Math.min(1.5, (sector[1] - sector[0]) / 4);
    deg = Math.min(Math.max(deg, sector[0] + pad), sector[1] - pad);
  }
  const [nx, ny] = toXY(L, deg, Math.max(pol.r, rMin * 0.92));
  p.deg = deg;
  p.x = nx;
  p.y = ny;
  p.box = nodeBox(p.node, nx, ny, p.side);
}

// Push-apart relaxation on the real label boxes. The core, the section captions and the
// ACTIVITY dock are immovable; nodes move until every pair clears CLEAR_TARGET or the
// passes run out. Returns the tightest NODE-to-NODE gap: obstacles still push, but a
// reservation a node cannot escape must not make the caller inflate the whole field
// (that trades every label's size for space nothing was going to use).
function relaxField(placed, obstacles, sectors, L, rMin) {
  let minClear = Infinity;
  for (let pass = 0; pass < RELAX_PASSES; pass++) {
    const dx = new Array(placed.length).fill(0);
    const dy = new Array(placed.length).fill(0);
    minClear = Infinity;
    // Counted separately from minClear: a one-node field has no pairs at all, and
    // exiting on the pair test alone would skip the obstacle pushes entirely.
    let tight = 0;
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const gap = boxClearance(placed[i].box, placed[j].box);
        if (gap < minClear) minClear = gap;
        if (gap >= CLEAR_TARGET) continue;
        tight++;
        const [ux, uy] = pushDir(placed[i].box, placed[j].box);
        const m = (CLEAR_TARGET - gap) * 0.28;
        dx[i] += ux * m; dy[i] += uy * m;
        dx[j] -= ux * m; dy[j] -= uy * m;
      }
      for (const ob of obstacles) {
        const gap = boxClearance(placed[i].box, ob);
        if (gap >= CLEAR_TARGET) continue;
        tight++;
        const [ux, uy] = pushDir(placed[i].box, ob);
        const m = (CLEAR_TARGET - gap) * 0.5;
        dx[i] += ux * m; dy[i] += uy * m;
      }
    }
    if (!tight) break;
    for (let i = 0; i < placed.length; i++) {
      if (!dx[i] && !dy[i]) continue;
      movePlaced(placed[i], placed[i].x + dx[i], placed[i].y + dy[i], sectors[placed[i].zone], L, rMin);
    }
  }
  return minClear === Infinity ? CLEAR_TARGET : minClear;
}

// Liang-Barsky: does the segment touch the box at all?
function segHitsBox(x1, y1, x2, y2, b) {
  const dx = x2 - x1, dy = y2 - y1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - b[0], b[2] - x1, y1 - b[1], b[3] - y1];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
      else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
  }
  return true;
}

// The drawn spoke: core boundary ring to hex edge. Shared with buildLink so the
// crossing test measures the line the reader actually sees.
function spokeSegment(x, y, L) {
  const dx = x - L.coreX, dy = y - L.coreY;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d, uy = dy / d;
  return [L.coreX + ux * (L.coreR + 6), L.coreY + uy * (L.coreR + 6), x - ux * (HEX_R + 12), y - uy * (HEX_R + 12)];
}

function spokeHits(p, placed, L) {
  const [x1, y1, x2, y2] = spokeSegment(p.x, p.y, L);
  let hits = 0;
  for (const other of placed) {
    if (other === p) continue;
    if (segHitsBox(x1, y1, x2, y2, other.box)) hits++;
  }
  return hits;
}

function fieldClearance(p, placed, obstacles) {
  let min = Infinity;
  for (const other of placed) {
    if (other === p) continue;
    min = Math.min(min, boxClearance(p.box, other.box));
  }
  for (const ob of obstacles) min = Math.min(min, boxClearance(p.box, ob));
  return min;
}

// A spoke running through another node's label makes the text unreadable, so nudge the
// offender along its own arc (or a little further out) until the crossing clears. A
// candidate that costs clearance is rejected, so this pass can only improve the field.
const SPOKE_NUDGES = [
  [4, 1], [-4, 1], [8, 1], [-8, 1], [14, 1], [-14, 1], [20, 1], [-20, 1],
  [0, 1.1], [6, 1.1], [-6, 1.1], [0, 1.22], [12, 1.22], [-12, 1.22],
];
function repairSpokes(placed, obstacles, sectors, L, rMin) {
  for (let round = 0; round < 4; round++) {
    let moved = 0;
    for (const p of placed) {
      const hits = spokeHits(p, placed, L);
      if (!hits) continue;
      const home = { x: p.x, y: p.y, deg: p.deg, box: p.box };
      const homeClear = fieldClearance(p, placed, obstacles);
      const start = toPolar(L, p.x, p.y);
      let best = null;
      for (const [dDeg, rMul] of SPOKE_NUDGES) {
        const [nx, ny] = toXY(L, start.deg + dDeg, start.r * rMul);
        movePlaced(p, nx, ny, sectors[p.zone], L, rMin);
        const h = spokeHits(p, placed, L);
        const clear = fieldClearance(p, placed, obstacles);
        if (h < hits && clear >= Math.min(homeClear, CLEAR_TARGET) && (!best || h < best.hits)) {
          best = { x: p.x, y: p.y, deg: p.deg, box: p.box, hits: h };
          if (!h) break;
        }
      }
      p.x = (best || home).x;
      p.y = (best || home).y;
      p.deg = (best || home).deg;
      p.box = (best || home).box;
      if (best) moved++;
    }
    if (!moved) break;
  }
}

// Section caption for a zone, parked in the empty annulus between the core and the
// zone's first ring. Immovable: nodes are pushed clear of it, not the other way round.
function zoneCaption(text, cls, x, y) {
  const w = text.length * CLASS_CH + 20;
  return { text, cls, x, y, box: [x - w / 2, y - 16, x + w / 2, y + 6] };
}

// NOTE: the ACTIVITY overlay is deliberately NOT an obstacle here. Reserving even a
// small corner of the field for it inflated the drawn extent by 94% (measured, 22 real
// nodes: label text 9.75px -> 6.96px), because nodes pinned to a zone sector can only
// escape a reservation radially, which grows the extent, which re-anchors the
// reservation further out. The overlay floats instead: it is semi-transparent, sits in
// the emptiest corner of the field, and collapses to a pill.

// Place every node: zone sectors, ring packing, jitter, push-apart relaxation, spoke
// repair. When the field cannot hold its clearance it is expanded outward and relaxed
// again - nodes are never dropped and never packed tighter than CLEAR_FLOOR.
function layoutField(agents, L) {
  const byZone = {};
  for (const a of agents) {
    const z = zoneOf(a);
    (byZone[z] || (byZone[z] = [])).push(a);
  }
  const sectors = zoneSectors(byZone);
  const rMin = L.coreR + 190;
  const placed = [];
  const captions = [];
  for (const zone of Object.keys(sectors)) {
    const packed = packZone(byZone[zone], sectors[zone], L, rMin);
    for (const slot of packed.placed) {
      const side = pickSide(L, slot.deg, slot.ring === packed.rings - 1);
      const [x, y] = toXY(L, slot.deg, slot.r);
      placed.push({ node: slot.node, zone, deg: slot.deg, x, y, side, box: nodeBox(slot.node, x, y, side) });
    }
    const mid = (sectors[zone][0] + sectors[zone][1]) / 2;
    const [cx, cy] = toXY(L, mid, Math.max(L.coreR + 120, rMin - 74));
    captions.push(zoneCaption(ZONE_CAPTION[zone], zone === 'ambient' ? 'cap-amb' : '', cx, cy));
  }
  const obstacles = [coreBox(L)].concat(captions.map((c) => c.box));
  let minClear = relaxField(placed, obstacles, sectors, L, rMin);
  for (let t = 0; t < EXPAND_TRIES && minClear < CLEAR_TARGET; t++) {
    for (const p of placed) {
      const pol = toPolar(L, p.x, p.y);
      const [nx, ny] = toXY(L, pol.deg, pol.r * 1.14);
      p.x = nx;
      p.y = ny;
      p.box = nodeBox(p.node, nx, ny, p.side);
    }
    minClear = relaxField(placed, obstacles, sectors, L, rMin);
  }
  repairSpokes(placed, obstacles, sectors, L, rMin);
  let final = Infinity;
  for (let i = 0; i < placed.length; i++) {
    for (const ob of obstacles) final = Math.min(final, boxClearance(placed[i].box, ob));
    for (let j = i + 1; j < placed.length; j++) final = Math.min(final, boxClearance(placed[i].box, placed[j].box));
  }
  return { placed, captions, minClear: final === Infinity ? CLEAR_TARGET : final };
}

function nodeClassLabel(node) {
  return node.group === 'ambient' ? 'SESSION AGENT' : String(node.class || '').toUpperCase();
}

// Widest of the three label lines, in svg user units. Mono throughout, so a glyph
// count times a per-size advance is accurate enough to space nodes by.
function nodeLabelWidth(node) {
  const info = modelChipInfo(node.model);
  const chipW = info.label.length * CHIP_CH + 12 + 8 + 8 * CHIP_CH; // badge + gap + "00m ago"
  return Math.max(displayAgent(node.name).length * NAME_CH, nodeClassLabel(node).length * CLASS_CH, chipW);
}

// Drawn extent of a node including its label block: [x0, y0, x1, y1].
function nodeBox(node, x, y, side) {
  const w = nodeLabelWidth(node);
  if (side === 'down') {
    const half = Math.max(HEX_R, w / 2);
    return [x - half, y - HEX_R, x + half, y + HEX_R + LABEL_DROP];
  }
  const reach = HEX_R + 18 + w;
  return side === 'left'
    ? [x - reach, y - HEX_R - 14, x + HEX_R, y + HEX_R + 12]
    : [x - HEX_R, y - HEX_R - 14, x + reach, y + HEX_R + 12];
}

function newExtent() {
  return { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
}

function growExtent(e, box) {
  e.x0 = Math.min(e.x0, box[0]);
  e.y0 = Math.min(e.y0, box[1]);
  e.x1 = Math.max(e.x1, box[2]);
  e.y1 = Math.max(e.y1, box[3]);
}

// Mirrors modelBadge() colors; HTML badges cannot live inside the svg.
function modelChipInfo(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('opus')) return { label: 'OPUS', cls: 'nb-opus' };
  if (m.includes('sonnet')) return { label: 'SONNET', cls: 'nb-sonnet' };
  if (m.includes('haiku')) return { label: 'HAIKU', cls: 'nb-haiku' };
  if (m.includes('session')) return { label: 'SESSION', cls: 'nb-session' };
  return { label: String(model || '?').toUpperCase(), cls: 'nb-dim' };
}

function graphDefs() {
  const defs = svg('defs');
  const filter = svg('filter', { id: 'glow', x: '-60%', y: '-60%', width: '220%', height: '220%' });
  filter.appendChild(svg('feGaussianBlur', { stdDeviation: 5, result: 'b' }));
  const merge = svg('feMerge');
  merge.appendChild(svg('feMergeNode', { in: 'b' }));
  merge.appendChild(svg('feMergeNode', { in: 'SourceGraphic' }));
  filter.appendChild(merge);
  defs.appendChild(filter);
  // Arrowheads: the 'auto' pair sits at the node end (dispatch); the Rev pair
  // flips to the core end for return traffic via marker-start + auto-start-reverse.
  const heads = [
    ['ahCyan', 'ah-cyan', 'auto'], ['ahGold', 'ah-gold', 'auto'], ['ahViolet', 'ah-violet', 'auto'],
    ['ahCyanRev', 'ah-cyan', 'auto-start-reverse'], ['ahGoldRev', 'ah-gold', 'auto-start-reverse'],
    ['ahVioletRev', 'ah-violet', 'auto-start-reverse'],
  ];
  for (const [id, cls, orient] of heads) {
    const m = svg('marker', { id, viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 11, markerHeight: 11, markerUnits: 'userSpaceOnUse', orient });
    m.appendChild(svg('path', { d: 'M0 1 L9 5 L0 9 Z', class: cls }));
    defs.appendChild(m);
  }
  return defs;
}

// Chip row = model badge rect + heartbeat text. Returns a relayout closure so
// the 5s tick can refresh the heartbeat and re-align end/center-anchored rows.
function buildChipRow(g, agent, side, ax, ay) {
  const info = modelChipInfo(agent.model);
  const bw = info.label.length * CHIP_CH + 12;
  const rect = svg('rect', { class: 'nchip-badge ' + info.cls, width: bw, height: 16, rx: 2, y: ay - 12 });
  const btxt = svg('text', { class: 'nchip-btext ' + info.cls, y: ay, 'text-anchor': 'middle' });
  btxt.textContent = info.label;
  const hbt = svg('text', { class: 'nchip-hb', y: ay, 'text-anchor': 'start' });
  g.appendChild(rect);
  g.appendChild(btxt);
  g.appendChild(hbt);
  const place = () => {
    const hbs = fmtRel(graphSeenMs(agent.name));
    hbt.textContent = hbs;
    const total = bw + 8 + hbs.length * CHIP_CH;
    const bx = side === 'right' ? ax : (side === 'left' ? ax - total : ax - total / 2);
    rect.setAttribute('x', bx.toFixed(1));
    btxt.setAttribute('x', (bx + bw / 2).toFixed(1));
    hbt.setAttribute('x', (bx + bw + 8).toFixed(1));
  };
  place();
  return place;
}

function buildHexNode(node, x, y, side) {
  const amb = node.group === 'ambient';
  const g = svg('g', { class: 'gnode' + (amb ? ' gnode-amb' : ''), transform: 'translate(' + x.toFixed(1) + ' ' + y.toFixed(1) + ')', tabindex: '0', role: 'button' });
  g.setAttribute('aria-label', node.name + ', open comms feed');
  // The hex and its labels ride an inner group so the drift animation can move them
  // without touching the placement transform on the outer <g>. Period and phase come
  // from the name hash, so every node floats out of step with its neighbours and a
  // rebuild never resets the field to a synchronised twitch.
  const float = svg('g', { class: 'gfloat' });
  float.style.animationDuration = (12 + hashUnit(node.name, 'dur') * 8).toFixed(1) + 's';
  float.style.animationDelay = '-' + (hashUnit(node.name, 'phase') * 20).toFixed(1) + 's';
  g.appendChild(float);
  float.appendChild(svg('path', { d: hexPath(HEX_R), class: 'hex' }));
  const gl = amb ? ambientGlyph() : classGlyph(node.class);
  gl.setAttribute('transform', 'scale(1.05)');
  float.appendChild(gl);

  const anchor = side === 'down' ? 'middle' : (side === 'left' ? 'end' : 'start');
  const tx = side === 'down' ? 0 : (side === 'left' ? -(HEX_R + 18) : HEX_R + 18);
  const nameY = side === 'down' ? HEX_R + 18 : -8;
  const name = svg('text', { x: tx, y: nameY, class: 'nlabel-name', 'text-anchor': anchor });
  name.textContent = displayAgent(node.name);
  float.appendChild(name);
  const cls = svg('text', { x: tx, y: nameY + 15, class: 'nlabel-class', 'text-anchor': anchor });
  cls.textContent = nodeClassLabel(node);
  float.appendChild(cls);
  const refreshChips = buildChipRow(float, node, side, tx, nameY + 33);

  g.addEventListener('mouseenter', (e) => showTooltip(node, e));
  g.addEventListener('mousemove', (e) => moveTooltip(e));
  g.addEventListener('mouseleave', hideTooltip);
  g.addEventListener('focus', (e) => showTooltip(node, e));
  g.addEventListener('blur', hideTooltip);
  const go = () => gotoComms(node.name);
  g.addEventListener('click', go);
  g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  state.graphNodes.set(node.name, { g, refreshChips, group: node.group });
  return g;
}

// Straight connector from the core boundary ring to the hex edge.
function buildLink(linksG, node, x, y, L) {
  const [x1, y1, x2, y2] = spokeSegment(x, y, L);
  const line = svg('line', {
    x1: x1.toFixed(1), y1: y1.toFixed(1), x2: x2.toFixed(1), y2: y2.toFixed(1),
    class: 'glink' + (node.group === 'ambient' ? ' glink-amb' : ''),
  });
  linksG.appendChild(line);
  state.graphLinks.set(node.name, line);
}

// Arc-reactor core for A.L.B.E.R.T.: boundary ring with slow orbital dots, concentric
// rings, and a triangular reactor heart.
function buildCore(root, L) {
  const core = svg('g', { class: 'core', transform: 'translate(' + L.coreX + ' ' + L.coreY + ')', tabindex: '0', role: 'button' });
  core.setAttribute('aria-label', 'A.L.B.E.R.T. orchestrator, open comms feed');
  // The boundary circle rides inside the rotating group so its bounding box is
  // symmetric and fill-box rotation stays centered on the core.
  const orbit = svg('g', { class: 'core-orbit rot-slow' });
  orbit.appendChild(svg('circle', { r: L.coreR, class: 'core-bound', fill: 'none' }));
  for (let i = 0; i < 5; i++) {
    const [ox, oy] = polar(0, 0, L.coreR, i * 72 - 90);
    orbit.appendChild(svg('circle', { cx: ox.toFixed(1), cy: oy.toFixed(1), r: 3, class: 'odot' }));
  }
  core.appendChild(orbit);
  core.appendChild(svg('circle', { r: (L.coreR * 0.72).toFixed(1), class: 'core-ring cr1', fill: 'none' }));
  core.appendChild(svg('circle', { r: (L.coreR * 0.56).toFixed(1), class: 'core-ring cr2', fill: 'none', 'stroke-dasharray': '4 6' }));
  core.appendChild(svg('circle', { r: (L.coreR * 0.40).toFixed(1), class: 'core-ring cr3', fill: 'none' }));
  const heart = svg('g', { class: 'core-heart-g', filter: 'url(#glow)' });
  heart.appendChild(svg('circle', { r: (L.coreR * 0.26).toFixed(1), class: 'core-heart' }));
  heart.appendChild(svg('path', { d: 'M0 13 L-11.5 -7.5 L11.5 -7.5 Z', class: 'core-tri' }));
  core.appendChild(heart);
  const l1 = svg('text', { y: L.coreR + 36, class: 'core-label', 'text-anchor': 'middle' });
  l1.textContent = 'A.L.B.E.R.T.';
  const l2 = svg('text', { y: L.coreR + 54, class: 'core-sublabel', 'text-anchor': 'middle' });
  l2.textContent = 'ORCHESTRATOR';
  core.appendChild(l1);
  core.appendChild(l2);
  const albertAgent = state.byName.get(ALBERT_ID);
  core.addEventListener('mouseenter', (e) => { if (albertAgent) showTooltip(albertAgent, e); });
  core.addEventListener('mousemove', (e) => moveTooltip(e));
  core.addEventListener('mouseleave', hideTooltip);
  core.addEventListener('focus', (e) => { if (albertAgent) showTooltip(albertAgent, e); });
  core.addEventListener('blur', hideTooltip);
  core.addEventListener('click', () => gotoComms(ALBERT_ID));
  core.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); gotoComms(ALBERT_ID); } });
  root.appendChild(core);
  state.graphCore = core;
}

function gcap(text, x, y, anchor) {
  const t = svg('text', { x: x.toFixed(1), y: y.toFixed(1), class: 'gsec-cap', 'text-anchor': anchor });
  t.textContent = text;
  return t;
}

let graphIsWide = null;
let builtGraphSig = null;

// Identity of the rendered node set. updateGraph rebuilds when this changes, so a
// newly spawned agent type appears as a spoke on its first event. ORDER-INSENSITIVE on
// purpose: the ambient arc is sorted by dispatch count, and a count reorder must not
// tear down and rebuild the whole graph under the reader's cursor.
function graphSig(nodes) {
  const parts = nodes.map((n) => n.group + ':' + n.name + ':' + n.model);
  parts.sort();
  return parts.join('|');
}

// The graph element the user is on, as a node name (ALBERT_ID for the core), or null.
// Read before a teardown so the rebuilt tree can take the tab position back.
function focusedGraphName() {
  const active = document.activeElement;
  if (!active || active === document.body) return null;
  if (state.graphCore === active) return ALBERT_ID;
  for (const [name, node] of state.graphNodes) {
    if (node.g === active) return name;
  }
  return null;
}

function buildGraph() {
  const root = $('#graphSvg');
  // Clearing the tree detaches the hovered or keyboard-focused <g> without any
  // mouseleave/blur firing, which would strand the tooltip beside a node that no
  // longer exists and silently drop the tab position onto <body>. The node set now
  // rebuilds on any first sighting of an agent type, so this happens during normal use.
  hideTooltip();
  const refocusName = focusedGraphName();
  root.textContent = '';
  state.graphNodes.clear();
  state.graphLinks.clear();
  const index = globalAgentIndex();
  const agents = graphAgentNodes(index);
  builtGraphSig = graphSig(agents);
  // Chips render their heartbeat as they are built, so the global snapshot has to be
  // in place before the first node is drawn.
  currentAgentIndex = index;
  currentGraphSeen = seenMapFrom(index);
  const L = graphLayout();
  graphIsWide = L.wide;
  root.appendChild(graphDefs());

  const links = svg('g', { class: 'glinks' });
  const nodes = svg('g', { class: 'gnodes' });
  root.appendChild(links);
  root.appendChild(nodes);

  // Core box first: it anchors the fitted viewBox even when nothing else is drawn.
  const ext = newExtent();
  growExtent(ext, coreBox(L));

  const field = layoutField(agents, L);
  // Drift can never close a gap: two nodes can only approach by twice the amplitude, so
  // the amplitude is derived from the field's own tightest clearance.
  const drift = Math.max(0, Math.min(DRIFT_MAX, (field.minClear - 2) / 2));
  root.style.setProperty('--drift', drift.toFixed(1) + 'px');

  for (const cap of field.captions) {
    const t = gcap(cap.text, cap.x, cap.y, 'middle');
    if (cap.cls) t.classList.add(cap.cls);
    nodes.appendChild(t);
    growExtent(ext, cap.box);
  }
  for (const p of field.placed) {
    buildLink(links, p.node, p.x, p.y, L);
    nodes.appendChild(buildHexNode(p.node, p.x, p.y, p.side));
    growExtent(ext, p.box);
  }

  buildCore(root, L);

  if (!agents.length) {
    const t = svg('text', { x: L.coreX, y: L.coreY + L.coreR + 92, class: 'graph-empty', 'text-anchor': 'middle' });
    t.textContent = state.roster.length ? '[ NO AGENTS OBSERVED ]' : '[ AWAITING ROSTER ]';
    root.appendChild(t);
    growExtent(ext, [L.coreX - 220, L.coreY + L.coreR + 70, L.coreX + 220, L.coreY + L.coreR + 100]);
  }

  // Floor the extent around the core: a one- or two-node run would otherwise fit so
  // tightly that the reactor fills the whole panel.
  growExtent(ext, [L.coreX - L.W * 0.28, L.coreY - L.H * 0.26, L.coreX + L.W * 0.28, L.coreY + L.H * 0.26]);
  root.setAttribute('viewBox', [
    (ext.x0 - GRAPH_PAD).toFixed(1), (ext.y0 - GRAPH_PAD).toFixed(1),
    (ext.x1 - ext.x0 + GRAPH_PAD * 2).toFixed(1), (ext.y1 - ext.y0 + GRAPH_PAD * 2).toFixed(1),
  ].join(' '));

  if (refocusName) {
    const entry = state.graphNodes.get(refocusName);
    const target = refocusName === ALBERT_ID ? state.graphCore : (entry ? entry.g : null);
    if (target) target.focus();
  }

  updateGraph();
}

// Rebuild only when the layout mode flips; scaling within a mode is pure viewBox.
window.addEventListener('resize', () => {
  if (graphIsWide !== null && (window.innerWidth >= GRAPH_WIDE_MIN) !== graphIsWide) buildGraph();
});

// Most recent direction per agent across ALL streams: 'return' if the agent reported
// last (actor === agent), 'dispatch' if it was last addressed as a target. Compared by
// timestamp rather than stream order, so the newest sighting anywhere wins.
function latestDirections() {
  const dir = new Map();
  // Keyed on the rendered node set, not the roster: session agents own spokes now.
  const consider = (name, ms, d) => {
    if (!name || ms == null || !state.graphNodes.has(name)) return;
    const cur = dir.get(name);
    if (!cur || ms > cur.ms) dir.set(name, { ms, dir: d });
  };
  eachEventStream((events) => {
    for (const ev of events) {
      consider(ev.actor, ev.ms, 'return');
      consider(ev.target, ev.ms, 'dispatch');
    }
  });
  return dir;
}

function updateGraph() {
  const index = globalAgentIndex();
  // The node set follows all observed traffic, so a first sighting of a new agent type
  // anywhere has to rebuild the spokes before they can be lit.
  if (graphSig(graphAgentNodes(index)) !== builtGraphSig) { buildGraph(); return; }
  currentAgentIndex = index;
  currentGraphSeen = seenMapFrom(index);
  const working = globalWorking();
  const hot = hotSet(currentGraphSeen);
  const dirs = latestDirections();
  let litNodes = 0;
  for (const [name, node] of state.graphNodes) {
    const active = working.has(name) || hot.has(name);
    if (active) litNodes++;
    node.g.classList.toggle('active', active);
    node.g.classList.toggle('unseen', !currentGraphSeen.has(name));
    node.refreshChips();
    const link = state.graphLinks.get(name);
    if (link) {
      link.classList.toggle('hot', active);
      const d = dirs.get(name);
      const isReturn = !!d && d.dir === 'return';
      link.classList.toggle('ret', isReturn);
      const head = active ? 'ahGold' : (node.group === 'ambient' ? 'ahViolet' : 'ahCyan');
      if (isReturn) {
        link.removeAttribute('marker-end');
        link.setAttribute('marker-start', 'url(#' + head + 'Rev)');
      } else {
        link.removeAttribute('marker-start');
        link.setAttribute('marker-end', 'url(#' + head + ')');
      }
    }
  }
  const coreLit = working.has(ALBERT_ID) || isCoreActive(currentGraphSeen);
  if (state.graphCore) state.graphCore.classList.toggle('working', coreLit);
  updateGraphCorners(litNodes, coreLit);
  currentActivity = activityItems();
  renderActivityHud();
}

/* ---------------- ACTIVITY panel ---------------- */

// Snapshotted alongside the agent index so the panel and the RECENT WORK tooltip read
// the same list, and so a hover never has to rescan every stream.
let currentActivity = null;
let activitySig = null;
let activityOpen = null;

// Collapsed state, remembered like the view tab. A narrow window must never lose the
// graph behind the overlay, so the default below ACTIVITY_OPEN_MIN is collapsed.
function activityExpanded() {
  if (activityOpen !== null) return activityOpen;
  try {
    const v = localStorage.getItem(ACTIVITY_KEY);
    if (v === 'open') activityOpen = true;
    else if (v === 'closed') activityOpen = false;
  } catch (e) { /* storage unavailable */ }
  if (activityOpen === null) activityOpen = window.innerWidth >= ACTIVITY_OPEN_MIN;
  return activityOpen;
}

function setActivityExpanded(open) {
  activityOpen = open;
  try { localStorage.setItem(ACTIVITY_KEY, open ? 'open' : 'closed'); } catch (e) { /* storage unavailable */ }
  // Purely an overlay: the field does not move, so only the panel re-renders.
  activitySig = null;
  renderActivityHud();
}

function ensureActivityHud() {
  const existing = $('#activityHud');
  if (existing) return existing;
  const wrap = $('#graphWrap');
  if (!wrap) return null;
  const hud = el('section', 'hud-activity');
  hud.id = 'activityHud';
  hud.setAttribute('aria-label', 'Recent agent activity');
  const toggle = el('button', 'hud-title', '// ACTIVITY');
  toggle.id = 'activityToggle';
  toggle.type = 'button';
  toggle.setAttribute('aria-controls', 'activityRows');
  toggle.addEventListener('click', () => setActivityExpanded(!activityExpanded()));
  hud.appendChild(toggle);
  const rows = el('div', 'hud-rows');
  rows.id = 'activityRows';
  rows.tabIndex = 0;                      // the list scrolls, so it needs a tab stop
  rows.setAttribute('role', 'list');
  // Only re-rendered when the work list actually changes (relative times tick through
  // [data-ts]), so this does not narrate every 5s refresh.
  rows.setAttribute('aria-live', 'polite');
  hud.appendChild(rows);
  wrap.appendChild(hud);
  return hud;
}

function activityRow(item) {
  const row = el('div', 'hud-row');
  row.setAttribute('role', 'listitem');
  const head = el('div', 'hud-row-head');
  head.appendChild(el('span', 'hud-agent' + (isLoopAgent(item.agent) ? '' : ' hud-agent-amb'), displayAgent(item.agent)));
  if (item.running) head.appendChild(el('span', 'hud-chip', 'RUNNING'));
  const rel = el('span', 'hud-rel num', fmtRel(item.ms));
  if (item.ms != null) rel.dataset.ts = String(item.ms);
  head.appendChild(rel);
  row.appendChild(head);
  row.appendChild(el('div', 'hud-desc', item.desc));
  const src = el('div', 'hud-src', item.source);
  src.title = item.source;
  row.appendChild(src);
  return row;
}

function renderActivityHud() {
  const hud = ensureActivityHud();
  if (!hud) return;
  const open = activityExpanded();
  const items = (currentActivity || []).slice(0, ACTIVITY_ROWS);
  const running = (currentActivity || []).filter((i) => i.running).length;
  const sig = (open ? 'o' : 'c') + '|' + running + '|'
    + items.map((i) => i.agent + '|' + i.ms + '|' + (i.running ? 1 : 0) + '|' + i.desc).join('~');
  if (sig === activitySig) return;
  activitySig = sig;
  hud.classList.toggle('collapsed', !open);
  const toggle = $('#activityToggle');
  // Collapsed, the pill still has to say whether anything is running.
  toggle.textContent = open ? '// ACTIVITY' : '// ACTIVITY (' + running + ')';
  toggle.setAttribute('aria-expanded', String(open));
  const box = $('#activityRows');
  box.textContent = '';
  box.hidden = !open;
  if (!open) return;
  if (!items.length) {
    box.appendChild(emptyState('NO RECENT ACTIVITY'));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const item of items) frag.appendChild(activityRow(item));
  box.appendChild(frag);
}

// Corner telemetry is GLOBAL, matching the map: the scope, how many sessions are live,
// how many agent nodes are lit right now, and the dispatches every session has made.
// The labels are set here rather than in the markup so the four corners can never
// disagree with the values written under them.
function updateGraphCorners(litNodes, coreLit) {
  let active = 0;
  let dispatches = 0;
  for (const s of state.sessions) {
    if (String(s.status || '').toLowerCase() === 'active') active++;
    dispatches += s.dispatches;
  }
  const label = (sel, text) => {
    const n = $(sel + ' .corner-label');
    if (n) n.textContent = text;
  };
  label('.corner.tl', 'SCOPE');
  label('.corner.tr', 'ACTIVE SESSIONS');
  label('.corner.bl', 'AGENTS RUNNING');
  label('.corner.br', 'TOTAL DISPATCHES');
  $('#cornerRun').textContent = 'ALL SESSIONS';
  $('#cornerIter').textContent = active + ' / ' + state.sessions.length;
  const litEl = $('#cornerTokens');
  litEl.textContent = String(litNodes);
  litEl.classList.toggle('lit', litNodes > 0);
  $('#cornerTasks').textContent = String(dispatches);
  const live = litNodes > 0 || coreLit || active > 0;
  const pillEl = $('#cornerStatus');
  pillEl.textContent = live ? 'LIVE' : 'IDLE';
  pillEl.className = 'pill ' + (live ? 'p-sess-active' : 'p-sess-idle');
}

/* ---------------- tooltip ---------------- */

const TIP_CALLER_ROWS = 6;   // callers listed before the "+N more" line
const TIP_WORK_ROWS = 3;     // recent work items listed per agent

// Graph-only. The heartbeat reads the same global seen map the graph was drawn from,
// so a tooltip always agrees with the chip under its hex.
function showTooltip(agent, e) {
  const tip = $('#tooltip');
  tip.textContent = '';
  tip.appendChild(el('div', 'tip-name', canonAgent(agent.name) === ALBERT_ID ? 'A.L.B.E.R.T.' : agent.name.toUpperCase()));
  tip.appendChild(el('div', 'tip-role', agent.role || ''));
  const meta = el('div', 'tip-meta');
  meta.appendChild(modelBadge(agent.model));
  meta.appendChild(el('span', 'tip-seen num', 'SEEN ' + fmtRel(graphSeenMs(agent.name))));
  tip.appendChild(meta);
  const work = workSection(agent.name);
  if (work) tip.appendChild(work);
  tip.appendChild(callerSection(agent.name));
  tip.hidden = false;
  moveTooltip(e);
}

// What this agent has actually been doing, newest first. Omitted entirely when the
// agent has no work in the scanned window: an empty header says nothing. Descriptions
// and session titles are model-authored, so they render through el()/textContent like
// every other string here.
function workSection(name) {
  const rows = (currentActivity || []).filter((r) => r.agent === name).slice(0, TIP_WORK_ROWS);
  if (!rows.length) return null;
  const box = el('div', 'tip-work');
  box.appendChild(el('div', 'tip-work-head', 'RECENT WORK'));
  for (const r of rows) {
    const item = el('div', 'tip-work-item');
    const desc = el('div', 'tip-work-desc');
    if (r.running) desc.appendChild(el('span', 'hud-chip', 'RUNNING'));
    desc.appendChild(el('span', null, r.desc));
    item.appendChild(desc);
    const meta = el('div', 'tip-work-meta');
    meta.appendChild(el('span', 'tip-work-src', r.source));
    meta.appendChild(el('span', 'tip-work-rel num', fmtRel(r.ms)));
    item.appendChild(meta);
    box.appendChild(item);
  }
  return box;
}

// Callers of one agent, most recently active first. The core is not dispatched by
// anyone, so it aggregates every caller on the box instead: "who is running agents".
function callerRows(name) {
  if (!currentAgentIndex) return [];
  if (canonAgent(name) === ALBERT_ID) {
    const merged = new Map();
    for (const entry of currentAgentIndex.values()) {
      for (const s of entry.sources.values()) {
        const cur = merged.get(s.id) || { kind: s.kind, id: s.id, label: s.label, count: 0, ms: null };
        if (s.label && !cur.label) cur.label = s.label;
        cur.count += s.count;
        if (s.ms != null && (cur.ms == null || s.ms > cur.ms)) cur.ms = s.ms;
        merged.set(s.id, cur);
      }
    }
    return sortCallers(merged.values());
  }
  const entry = currentAgentIndex.get(name);
  return entry ? sortCallers(entry.sources.values()) : [];
}

function sortCallers(values) {
  return Array.from(values).sort((a, b) => {
    const am = a.ms == null ? -Infinity : a.ms;
    const bm = b.ms == null ? -Infinity : b.ms;
    return bm === am ? b.count - a.count : bm - am;
  });
}

// A caller's display name: the session title, else a short session id, else the run id.
function callerLabel(s) {
  if (s.label) return s.label;
  return s.kind === 'session' ? String(s.id).slice(0, 8) : String(s.id);
}

// Which sessions (or store runs) dispatched this agent. Session titles are
// model-authored free text and go through el()/textContent like every other string in
// this file; long ones ellipsis in CSS rather than being cut here. No other
// transcript-derived text is rendered.
function callerSection(name) {
  const box = el('div', 'tip-callers');
  box.appendChild(el('div', 'tip-callers-head', 'CALLED BY'));
  const rows = callerRows(name);
  if (!rows.length) {
    box.appendChild(el('div', 'tip-caller-none', 'no session attribution'));
    return box;
  }
  for (const s of rows.slice(0, TIP_CALLER_ROWS)) {
    const row = el('div', 'tip-caller');
    row.appendChild(el('span', 'tip-caller-name', callerLabel(s)));
    row.appendChild(el('span', 'tip-caller-count num', s.count ? 'x' + s.count : '-'));
    row.appendChild(el('span', 'tip-caller-rel num', fmtRel(s.ms)));
    box.appendChild(row);
  }
  if (rows.length > TIP_CALLER_ROWS) {
    box.appendChild(el('div', 'tip-caller-more', '+' + (rows.length - TIP_CALLER_ROWS) + ' more'));
  }
  return box;
}

function moveTooltip(e) {
  const tip = $('#tooltip');
  if (tip.hidden) return;
  const pad = 14;
  let x = (e.clientX || 0) + pad;
  let y = (e.clientY || 0) + pad;
  const r = tip.getBoundingClientRect();
  if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
  tip.style.left = Math.max(8, x) + 'px';
  tip.style.top = Math.max(8, y) + 'px';
}

function hideTooltip() { $('#tooltip').hidden = true; }

/* ---------------- SESSIONS ---------------- */

function runUpdatedMs(runId) {
  const feed = state.feeds.get(runId);
  if (!feed) return null;
  const newest = feed.find((e) => e.ms != null);
  return newest ? newest.ms : null;
}

function surfaceBadge(surface) {
  const s = String(surface || '').toLowerCase();
  const isVs = s === 'claude-vscode';
  return el('span', 'surf-badge ' + (isVs ? 'sf-vscode' : 'sf-unknown'), isVs ? 'VSCODE' : 'UNKNOWN');
}

function sessionStatusPill(status) {
  const s = String(status || '').toLowerCase();
  const isActive = s === 'active';
  return el('span', 'pill ' + (isActive ? 'p-sess-active' : 'p-sess-idle'), isActive ? 'ACTIVE' : 'IDLE');
}

// Column classes travel with the cells so the stylesheet can size them proportionally
// (table-layout: fixed) and drop the lowest-value ones when the pane is dragged narrow.
const RUN_COLS = [
  ['RUN', 'c-run'], ['PROJECT', 'c-proj'], ['STATUS', 'c-status'],
  ['ITER', 'c-iter num'], ['TOKENS', 'c-rtok num'], ['UPDATED', 'c-upd num'],
];
const SESSION_COLS = [
  ['TITLE', 'c-title sess-title'], ['PROJECT', 'c-proj sess-proj'], ['SURFACE', 'c-surface'],
  ['STATUS', 'c-status'], ['TURNS', 'c-turns num'], ['DISP', 'c-disp num'],
  ['TOKENS', 'c-stok num'], ['UPDATED', 'c-upd num'],
];

function headRow(cols) {
  const hr = el('tr');
  // The header takes the sizing class only; the rest are cell-level text styles.
  for (const [label, cls] of cols) hr.appendChild(el('th', cls.split(' ')[0], label));
  return hr;
}

// Claude Code sessions. A separate noun from harness runs: separate table, never merged.
function renderSessionsGroup(list) {
  const sec = el('section', 'sess-group cc-group');
  sec.appendChild(el('h2', 'section-title', '// CLAUDE CODE SESSIONS'));
  if (!state.sessions.length) {
    sec.appendChild(emptyState('NO SESSIONS OBSERVED'));
    list.appendChild(sec);
    return;
  }
  const table = el('table', 'runs-table sess-table');
  const thead = el('thead');
  thead.appendChild(headRow(SESSION_COLS));
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const s of state.sessions) tbody.appendChild(sessionRow(s));
  table.appendChild(tbody);
  sec.appendChild(table);
  list.appendChild(sec);
}

function sessionRow(s) {
  const tr = el('tr');
  tr.dataset.sid = s.session_id;
  tr.tabIndex = 0;
  tr.setAttribute('role', 'button');
  for (const [, cls] of SESSION_COLS) tr.appendChild(el('td', cls));
  fillSessionRow(tr, s);
  const open = () => {
    state.sessionSel = s.session_id;
    state.detailKind = 'session';
    renderSessions();
    ensureSessionDetail(s.session_id).then(renderSessions).catch(() => {});
  };
  tr.addEventListener('click', open);
  tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  return tr;
}

// Writes the cells of an existing row. Shared by the initial build and the live
// patch path so the two orderings can never drift apart.
function fillSessionRow(tr, s) {
  const c = tr.children;
  const label = sessionLabel(s);
  tr.classList.toggle('sel', state.detailKind === 'session' && s.session_id === state.sessionSel);
  tr.setAttribute('aria-label', 'Open session ' + label);
  // Column classes come from SESSION_COLS at build time; only the content changes here.
  c[0].textContent = label;
  c[0].title = label;
  c[1].textContent = s.project || '-';
  c[1].title = s.project || '';
  c[2].textContent = '';
  c[2].appendChild(surfaceBadge(s.surface));
  c[3].textContent = '';
  c[3].appendChild(sessionStatusPill(s.status));
  c[4].textContent = String(s.turns);
  c[5].textContent = String(s.dispatches);
  c[6].textContent = fmtCompact(s.tokens);
  c[7].textContent = fmtRel(s.ms);
  if (s.ms != null) c[7].dataset.ts = String(s.ms);
  else delete c[7].dataset.ts;
}

function sessionRowEl(id) {
  return $$('#sessionsList tr[data-sid]').find((r) => r.dataset.sid === id) || null;
}

// Move the row to its position in the newest-first sort without rebuilding the
// table. Moving a node blurs it, so hand focus back when it was the focused row.
function placeSessionRow(row, s) {
  const tbody = row.parentNode;
  const idx = state.sessions.indexOf(s);
  if (!tbody || idx < 0) return;
  const ref = $$('tr', tbody).filter((r) => r !== row)[idx] || null;
  if (row.nextSibling === ref) return;
  const hadFocus = document.activeElement === row;
  tbody.insertBefore(row, ref);
  if (hadFocus) row.focus({ preventScroll: true });
}

/* ---------------- sessions split (draggable divider) ---------------- */

const SPLIT_KEY = 'hc.sessionsSplit';
const SPLIT_DEFAULT = 520;   // every column fits at this width, so nothing is hidden
const SPLIT_MIN = 300;
const DETAIL_MIN = 360;
const SPLIT_STEP = 24;       // arrow-key nudge

let splitPx = null;

function splitWidth() {
  if (splitPx == null) {
    let stored = null;
    try { stored = Number(localStorage.getItem(SPLIT_KEY)); } catch (e) { /* storage unavailable */ }
    splitPx = Number.isFinite(stored) && stored > 0 ? stored : SPLIT_DEFAULT;
  }
  return splitPx;
}

// The list never goes under SPLIT_MIN and the detail never under DETAIL_MIN. On a window
// too narrow for both the list gives way first: the detail is the reading pane.
function splitMax() {
  const grid = $('.sess-grid');
  const total = grid ? grid.clientWidth : 0;
  if (!total) return SPLIT_DEFAULT;
  return Math.max(SPLIT_MIN, total - DETAIL_MIN);
}

function applySplit(px, persist) {
  const max = splitMax();
  splitPx = Math.min(Math.max(Math.round(px), SPLIT_MIN), max);
  const grid = $('.sess-grid');
  if (grid) grid.style.setProperty('--sess-list-w', splitPx + 'px');
  const bar = $('#sessSplit');
  if (bar) {
    bar.setAttribute('aria-valuenow', String(splitPx));
    bar.setAttribute('aria-valuemin', String(SPLIT_MIN));
    bar.setAttribute('aria-valuemax', String(Math.round(max)));
  }
  if (persist) {
    try { localStorage.setItem(SPLIT_KEY, String(splitPx)); } catch (e) { /* storage unavailable */ }
  }
}

// The divider is built here rather than in the markup so index.html keeps its two-pane
// shape; it is created once and survives every renderSessions() (which only clears the
// panes' own contents).
function ensureSplitBar() {
  const existing = $('#sessSplit');
  if (existing) { applySplit(splitWidth(), false); return existing; }
  const grid = $('.sess-grid');
  const detail = $('#sessionsDetail');
  if (!grid || !detail) return null;
  const bar = el('div', 'sess-split');
  bar.id = 'sessSplit';
  bar.tabIndex = 0;
  bar.setAttribute('role', 'separator');
  bar.setAttribute('aria-orientation', 'vertical');
  bar.setAttribute('aria-label', 'Resize the sessions list, arrow keys to adjust, double click to reset');
  grid.insertBefore(bar, detail);
  wireSplitBar(bar, grid);
  applySplit(splitWidth(), false);
  return bar;
}

function wireSplitBar(bar, grid) {
  let dragging = false;
  const stop = () => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('dragging');
    grid.classList.remove('resizing');
    applySplit(splitPx, true);
  };
  bar.addEventListener('pointerdown', (e) => {
    dragging = true;
    bar.classList.add('dragging');
    grid.classList.add('resizing');
    if (bar.setPointerCapture) bar.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  bar.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    applySplit(e.clientX - grid.getBoundingClientRect().left, false);
  });
  bar.addEventListener('pointerup', stop);
  bar.addEventListener('pointercancel', stop);
  bar.addEventListener('dblclick', () => applySplit(SPLIT_DEFAULT, true));
  bar.addEventListener('keydown', (e) => {
    let next = null;
    if (e.key === 'ArrowLeft') next = splitWidth() - SPLIT_STEP;
    else if (e.key === 'ArrowRight') next = splitWidth() + SPLIT_STEP;
    else if (e.key === 'Home') next = SPLIT_MIN;
    else if (e.key === 'End') next = splitMax();
    else if (e.key === 'Enter' || e.key === ' ') next = SPLIT_DEFAULT;
    if (next == null) return;
    e.preventDefault();
    applySplit(next, true);
  });
}

// A narrower window can push the stored split past its own maximum, so re-clamp.
window.addEventListener('resize', () => {
  if (state.view === 'sessions' && $('#sessSplit')) applySplit(splitWidth(), false);
});

function renderSessions() {
  ensureSplitBar();
  const list = $('#sessionsList');
  list.textContent = '';
  addCorners(list);
  const runsGroup = el('section', 'sess-group runs-group');
  list.appendChild(runsGroup);
  renderRunsGroup(runsGroup);
  renderSessionsGroup(list);
  renderDetailPane();
}

// Live summary on the SESSIONS view. Patch the one row that changed: a full
// renderSessions() would drop the reader's scroll and blur the focused row, and
// these land per message across every open project. Only a session the table has
// no row for needs the rebuild.
function patchSessions(s) {
  const row = sessionRowEl(s.session_id);
  if (!row) { renderSessions(); return; }
  fillSessionRow(row, s);
  placeSessionRow(row, s);
  if (state.detailKind === 'session' && s.session_id === state.sessionSel) patchSessionSummary(s);
  // A harness session (dispatched a loop-* agent) also appears in the HARNESS RUNS
  // list. Re-render only that list so its tokens/updated/status stay live without a
  // full renderSessions() teardown of the sessions table on every message.
  if (s.is_harness) patchHarnessRuns();
}

// Targeted re-render of just the HARNESS RUNS list (store runs + harness sessions).
function patchHarnessRuns() {
  const group = $('#sessionsList .runs-group');
  if (!group) { if (state.view === 'sessions') renderSessions(); return; }
  group.textContent = '';
  renderRunsGroup(group);
}

// Sessions that dispatched a loop-* agent are harness runs in their own right,
// newest first. A harness session and a store run are the SAME run only when their
// ids match exactly (session_id === run.id), which effectively never happens.
// Project overlap is NOT identity: two different Albert runs share a project all
// the time (e.g. a paused store run and a live audit loop, both in the same project),
// so deduping by project would wrongly hide a distinct live session.
function harnessSessionsForRuns() {
  const runIds = new Set(state.runs.map((r) => r.id));
  const out = [];
  for (const s of state.sessions) { // state.sessions is already sorted newest first
    if (!s.is_harness) continue;
    if (runIds.has(s.session_id)) continue;
    out.push(s);
  }
  return out;
}

function storeRunRow(r) {
  const tr = el('tr', (state.detailKind === 'run' && r.id === state.sessionsSel) ? 'sel' : null);
  tr.tabIndex = 0;
  tr.setAttribute('role', 'button');
  tr.setAttribute('aria-label', 'Open run ' + r.id);
  const p = r.progress || {};
  const idCell = el('td', 'c-run run-id num', r.id);
  idCell.title = r.id;
  tr.appendChild(idCell);
  const projCell = el('td', 'c-proj', r.project || '-');
  projCell.title = r.project || '';
  tr.appendChild(projCell);
  const stCell = el('td', 'c-status');
  stCell.appendChild(makePill(r.status));
  if (r.indexStatus && r.indexStatus !== r.status) {
    const dot = el('span', 'index-dot');
    dot.title = 'index says ' + r.indexStatus;
    stCell.appendChild(dot);
  }
  tr.appendChild(stCell);
  tr.appendChild(el('td', 'c-iter num', p.iteration != null ? String(p.iteration) : '-'));
  tr.appendChild(el('td', 'c-rtok num', fmtCompact(p.tokens_spent)));
  const ms = runUpdatedMs(r.id);
  const upd = el('td', 'c-upd num', fmtRel(ms));
  if (ms != null) upd.dataset.ts = String(ms);
  tr.appendChild(upd);
  // Plain selection: the graph is global, so a row click neither pins it nor leaves
  // the Sessions view. It only points the detail pane at this run.
  const open = () => {
    state.sessionsSel = r.id;
    state.detailKind = 'run';
    renderSessions();
    if (!state.details.has(r.id)) ensureDetail(r.id).then(renderSessions).catch(() => {});
  };
  tr.addEventListener('click', open);
  tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  return tr;
}

// A harness SESSION rendered with the store-run columns adapted: RUN = session
// title/short id + a LIVE/SESSION tag, ITER = "-", STATUS = the session pill.
// Clicking selects it in the detail pane, exactly like a CLAUDE CODE SESSIONS row.
function harnessSessionRow(s) {
  const isLive = String(s.status || '').toLowerCase() === 'active';
  const tr = el('tr', 'harness-sess-row' + (state.detailKind === 'session' && s.session_id === state.sessionSel ? ' sel' : ''));
  tr.dataset.hsid = s.session_id;
  tr.tabIndex = 0;
  tr.setAttribute('role', 'button');
  const label = sessionLabel(s);
  tr.setAttribute('aria-label', 'Open harness session ' + label);

  // The flex row lives in an INNER div, not on the <td> itself: display:flex on a
  // table cell drops it out of fixed table-layout, so the cell ignored its 36% column
  // width and collapsed to just the tag, crushing the title to one character.
  const idCell = el('td', 'c-run');
  const wrap = el('div', 'run-cell');
  const idLabel = el('span', 'run-id num', label);
  idLabel.title = label;
  wrap.appendChild(idLabel);
  wrap.appendChild(el('span', 'live-tag' + (isLive ? ' lt-live' : ''), isLive ? 'LIVE' : 'SESSION'));
  idCell.appendChild(wrap);
  tr.appendChild(idCell);

  const projCell = el('td', 'c-proj', s.project || '-');
  projCell.title = s.project || '';
  tr.appendChild(projCell);

  const stCell = el('td', 'c-status');
  stCell.appendChild(sessionStatusPill(s.status));
  tr.appendChild(stCell);

  tr.appendChild(el('td', 'c-iter num', '-')); // sessions have no iteration counter
  tr.appendChild(el('td', 'c-rtok num', fmtCompact(s.tokens)));

  const upd = el('td', 'c-upd num', fmtRel(s.ms));
  if (s.ms != null) upd.dataset.ts = String(s.ms);
  tr.appendChild(upd);

  const open = () => {
    state.sessionSel = s.session_id;
    state.detailKind = 'session';
    renderSessions();
    ensureSessionDetail(s.session_id).then(renderSessions).catch(() => {});
  };
  tr.addEventListener('click', open);
  tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  return tr;
}

function renderRunsGroup(list) {
  list.appendChild(el('h2', 'section-title', '// HARNESS RUNS'));
  const harnessSessions = harnessSessionsForRuns();
  if (!state.runs.length && !harnessSessions.length) {
    list.appendChild(emptyState('NO RUNS REGISTERED'));
    return;
  }
  const table = el('table', 'runs-table');
  const thead = el('thead');
  thead.appendChild(headRow(RUN_COLS));
  table.appendChild(thead);
  const tbody = el('tbody');

  // Store runs and harness sessions are different nouns sharing one table; merge
  // them newest first. Undated rows (a store run whose feed is not loaded yet) sink
  // to the bottom, matching the "-" they already render for UPDATED.
  const rows = [];
  for (const r of state.runs) rows.push({ kind: 'run', run: r, ms: runUpdatedMs(r.id) });
  for (const s of harnessSessions) rows.push({ kind: 'session', session: s, ms: s.ms });
  rows.sort((a, b) => {
    if (a.ms == null && b.ms == null) return 0;
    if (a.ms == null) return 1;
    if (b.ms == null) return -1;
    return b.ms - a.ms;
  });
  for (const row of rows) {
    tbody.appendChild(row.kind === 'run' ? storeRunRow(row.run) : harnessSessionRow(row.session));
  }

  table.appendChild(tbody);
  list.appendChild(table);
}

// One detail region, two nouns. The pane renders whichever was selected last.
function renderDetailPane() {
  if (state.detailKind === 'session') renderClaudeSessionDetail();
  else renderSessionDetail();
}

function gauge(label, valueText, frac, warn) {
  const g = el('div', 'gauge');
  const head = el('div', 'gauge-head');
  head.appendChild(el('span', 'gauge-label', label));
  head.appendChild(el('span', 'gauge-val num', valueText));
  g.appendChild(head);
  const bar = el('div', 'gauge-bar');
  const fill = el('div', 'gauge-fill' + (warn ? ' g-warn' : ''));
  // Unknown fraction renders as a dim full track so it reads as "no data", not "zero".
  const ratio = frac == null ? 1 : Math.max(0, Math.min(1, frac));
  fill.style.transform = 'scaleX(' + ratio.toFixed(4) + ')';
  if (frac == null) fill.classList.add('g-unknown');
  bar.appendChild(fill);
  g.appendChild(bar);
  return g;
}

function taskGlyphFor(task) {
  const s = String(task.status || '').toLowerCase();
  if ((s === 'done' || s === 'complete' || s === 'completed') && task.passes) return ['ok', 'tg-done'];
  if (s === 'failed' || s === 'blocked' || s === 'error') return ['x', 'tg-fail'];
  return ['o', 'tg-pend'];
}

const DETAIL_LIST_CAP = 12;   // rows before a section collapses into "+N more"

// Agents that worked a store run, read from that run's own event feed with the same
// actor / dispatch-target rule the graph uses, so the two views can never disagree about
// who ran. The count is events naming the agent (dispatches to it plus results from it):
// a run has no per-agent summary to read, and counting dispatches alone would show "-"
// for the verifier and the QA agent, which only ever report back. Busiest first.
function runAgentRows(runId) {
  const index = new Map();
  const feed = state.feeds.get(runId) || [];
  collectFeedAgents(feed, index, { kind: 'run', id: runId, label: runId });
  const events = new Map();
  for (const ev of feed) {
    if (ev.ledger) continue;
    const who = workAgent(ev);
    if (who.name) events.set(who.name, (events.get(who.name) || 0) + 1);
  }
  const rows = [];
  for (const entry of index.values()) {
    const roster = state.byName.get(entry.name);
    rows.push({
      name: entry.name,
      count: events.get(entry.name) || 0,
      model: entry.model || (roster && roster.model) || '',
      ms: entry.ms,
    });
  }
  rows.sort((a, b) => (b.count - a.count) || ((b.ms || 0) - (a.ms || 0)));
  return rows;
}

// Shared row shape for both detail panes, so a run's agents and a session's agents read
// the same way. `loop` picks the cyan harness accent over the violet session one.
function agentRow(name, count, model, ms, isLoop, countHint) {
  const row = el('div', 'sagent-row' + (isLoop ? ' loop' : ''));
  row.appendChild(el('span', 'sagent-type', name));
  const cnt = el('span', 'sagent-count num', count ? 'x' + count : '-');
  cnt.title = countHint || '';
  row.appendChild(cnt);
  row.appendChild(modelBadge(model || '-'));
  const rel = el('span', 'sagent-seen num', fmtRel(ms));
  if (ms != null) rel.dataset.ts = String(ms);
  row.appendChild(rel);
  return row;
}

function moreNote(box, hidden) {
  if (hidden > 0) box.appendChild(el('p', 'more-note', '+' + hidden + ' more'));
}

function renderRunAgents(box, runId) {
  box.appendChild(el('h3', 'sub-title', '// AGENTS'));
  const rows = runAgentRows(runId);
  if (!rows.length) {
    box.appendChild(emptyState('NO AGENT TRAFFIC YET'));
    return;
  }
  for (const a of rows.slice(0, DETAIL_LIST_CAP)) {
    box.appendChild(agentRow(a.name, a.count, a.model, a.ms, isLoopAgent(a.name), 'events in this run naming this agent'));
  }
  moreNote(box, rows.length - DETAIL_LIST_CAP);
}

function isTaskDone(task) {
  const s = String(task.status || '').toLowerCase();
  return s === 'done' || s === 'complete' || s === 'completed' || s === 'merged';
}

// TASKS header. progress.json is the authority on how many tasks are done; tasks.json
// carries the checklist and its per-task statuses can lag it (a live run has all 22
// tasks "pending" while progress reports 9 done). Say so rather than inventing statuses.
function renderTasksHead(box, tasks, prog) {
  const head = el('div', 'tasks-head');
  head.appendChild(el('h3', 'sub-title', '// TASKS'));
  const done = prog && prog.tasks_done != null ? Number(prog.tasks_done) : null;
  if (done != null) head.appendChild(el('span', 'tasks-count num', done + ' / ' + tasks.length + ' DONE'));
  box.appendChild(head);
  if (done == null || !tasks.length) return;
  const marked = tasks.filter(isTaskDone).length;
  if (marked !== done) {
    box.appendChild(el('p', 'stale-note',
      'checklist below is tasks.json; progress.json reports ' + done + ' done and ' + marked
      + ' are marked here, so the per-task marks may lag'));
  }
}

function renderSessionDetail() {
  const box = $('#sessionsDetail');
  box.textContent = '';
  addCorners(box);
  const id = state.sessionsSel;
  if (!id) { box.appendChild(emptyState('NO RUN SELECTED')); return; }
  const detail = state.details.get(id);
  const run = state.runs.find((r) => r.id === id);
  if (!detail) {
    box.appendChild(el('h2', 'section-title', '// ' + id));
    box.appendChild(emptyState('LOADING RUN DATA'));
    return;
  }

  const head = el('div', 'detail-head');
  const title = el('h2', 'section-title num', '// ' + id);
  head.appendChild(title);
  const hm = el('div', 'detail-head-meta');
  // detail.project is the whole project.json object; the display name lives on the runs-list entry
  const projName = (run && run.project) ||
    (detail.project && typeof detail.project.project_path === 'string'
      ? detail.project.project_path.split(/[\\/]/).filter(Boolean).pop()
      : '');
  hm.appendChild(el('span', 'detail-project', projName || ''));
  const prog = detail.progress || (run && run.progress) || {};
  hm.appendChild(makePill(prog.status || (run && run.status)));
  head.appendChild(hm);
  box.appendChild(head);

  // budget gauges
  const budget = prog.budget || {};
  const gwrap = el('div', 'gauges');
  const iterFrac = budget.max_iterations ? (prog.iterations_spent != null ? prog.iterations_spent : prog.iteration) / budget.max_iterations : null;
  gwrap.appendChild(gauge('ITERATIONS', (prog.iterations_spent != null ? prog.iterations_spent : '-') + ' / ' + (budget.max_iterations != null ? budget.max_iterations : '-'), iterFrac, iterFrac != null && iterFrac > 0.8));
  const tokFrac = budget.max_tokens ? (prog.tokens_spent || 0) / budget.max_tokens : null;
  gwrap.appendChild(gauge('TOKENS', fmtCompact(prog.tokens_spent) + ' / ' + fmtCompact(budget.max_tokens), tokFrac, tokFrac != null && tokFrac > 0.8));
  const deadline = tsMs(budget.wall_deadline);
  let wallFrac = null, wallText = '-';
  if (deadline != null) {
    const startMs = tsMs(prog.started_at || prog.start_time || prog.created_at);
    wallText = fmtDur(deadline - Date.now()) + ' LEFT';
    if (startMs != null && deadline > startMs) wallFrac = (Date.now() - startMs) / (deadline - startMs);
  }
  gwrap.appendChild(gauge('WALL CLOCK', wallText, wallFrac, deadline != null && deadline - Date.now() < 24 * 3600 * 1000));
  box.appendChild(gwrap);

  // who actually worked this run
  renderRunAgents(box, id);

  // goal
  box.appendChild(el('h3', 'sub-title', '// GOAL'));
  const goalPre = el('pre', 'goal-pre', detail.goal || '(no goal.md)');
  box.appendChild(goalPre);

  // tasks grouped by chunk
  const tj = detail.tasks || {};
  const tasks = Array.isArray(tj.tasks) ? tj.tasks : [];
  const chunks = Array.isArray(tj.chunks) ? tj.chunks : [];
  renderTasksHead(box, tasks, prog);
  if (!tasks.length) {
    box.appendChild(emptyState('NO TASK PLAN'));
  } else {
    const seenChunks = chunks.map((c) => c.id);
    const extra = Array.from(new Set(tasks.map((t) => t.chunk).filter((c) => c && !seenChunks.includes(c))));
    const groups = chunks.concat(extra.map((id2) => ({ id: id2, title: id2 })));
    const orphan = tasks.filter((t) => !t.chunk);
    if (orphan.length) groups.push({ id: null, title: 'UNGROUPED' });
    for (const ch of groups) {
      const inChunk = tasks.filter((t) => (ch.id == null ? !t.chunk : t.chunk === ch.id));
      if (!inChunk.length) continue;
      const chHead = el('div', 'chunk-head');
      chHead.appendChild(el('span', 'chunk-id num', ch.id == null ? '' : String(ch.id).toUpperCase()));
      chHead.appendChild(el('span', 'chunk-title', ch.title || ''));
      box.appendChild(chHead);
      for (const t of inChunk) {
        const row = el('div', 'task-row');
        const [glyphText, glyphCls] = taskGlyphFor(t);
        row.appendChild(el('span', 't-glyph ' + glyphCls, glyphText));
        row.appendChild(el('span', 't-id num', t.id || ''));
        const tt = el('span', 't-title', t.title || '');
        tt.title = t.acceptance || t.title || '';
        row.appendChild(tt);
        row.appendChild(el('span', 't-role', (t.role || '').toUpperCase()));
        if (t.attempts != null) row.appendChild(el('span', 't-attempts num', 'x' + t.attempts));
        box.appendChild(row);
      }
    }
  }

  // status notes: free-text progress fields surfaced generically
  const notes = Array.isArray(detail.progressNotes) ? detail.progressNotes : [];
  if (notes.length) {
    box.appendChild(el('h3', 'sub-title', '// STATUS NOTES'));
    const nbox = el('dl', 'notes');
    for (const n of notes) {
      nbox.appendChild(el('dt', 'note-key', String(n.key || '').toUpperCase()));
      nbox.appendChild(el('dd', 'note-text', n.text || ''));
    }
    box.appendChild(nbox);
  }

  // iteration timeline
  box.appendChild(el('h3', 'sub-title', '// ITERATIONS'));
  const iters = Array.isArray(detail.iterations) ? detail.iterations.slice().sort((a, b) => Number(a.n) - Number(b.n)) : [];
  const ledger = Array.isArray(detail.ledger) ? detail.ledger : [];
  if (!iters.length && !ledger.length) {
    box.appendChild(emptyState('NO ITERATIONS YET'));
  } else {
    const byIter = new Map();
    for (const it of iters) byIter.set(String(it.n), { logs: it.logs || [], rows: [] });
    for (const row of ledger) {
      const key = String(row.iteration);
      if (!byIter.has(key)) byIter.set(key, { logs: [], rows: [] });
      byIter.get(key).rows.push(row);
    }
    const keys = Array.from(byIter.keys()).sort((a, b) => Number(a) - Number(b));
    for (const k of keys) {
      const entry = byIter.get(k);
      const blk = el('div', 'iter-block');
      blk.appendChild(el('div', 'iter-head num', 'ITER ' + k));
      for (const row of entry.rows) {
        const lr = el('div', 'ledger-line');
        lr.appendChild(el('span', 'll-task num', row.task_id || ''));
        lr.appendChild(el('span', 'll-role', (row.role || '').toUpperCase()));
        const verdict = String(row.verdict || '');
        const vcls = /fail|bug|block/i.test(verdict) ? 'll-warn' : (/pass|done/i.test(verdict) ? 'll-ok' : 'll-dim');
        lr.appendChild(el('span', 'll-verdict ' + vcls, verdict));
        const nt = el('span', 'll-notes', row.notes || '');
        nt.title = (row.evidence ? 'evidence: ' + row.evidence + ' :: ' : '') + (row.notes || '');
        lr.appendChild(nt);
        blk.appendChild(lr);
      }
      if (entry.logs.length) {
        const logRow = el('div', 'log-row');
        for (const f of entry.logs) {
          const b = el('button', 'log-btn', f);
          b.type = 'button';
          b.addEventListener('click', () => openLog(id, k, f));
          logRow.appendChild(b);
        }
        blk.appendChild(logRow);
      }
      box.appendChild(blk);
    }
  }
}

/* ---------------- Claude Code session detail ---------------- */

function verdictPill(verdict) {
  const v = String(verdict || '').toLowerCase();
  if (v === 'followed') return el('span', 'pill p-ok', 'FOLLOWED');
  if (v === 'mixed') return el('span', 'pill p-gold', 'MIXED');
  if (v === 'ignored') return el('span', 'pill p-err', 'IGNORED');
  return el('span', 'pill p-dim', 'N/A');
}

function kvRow(dl, key, value) {
  dl.appendChild(el('dt', 'kv-key', key));
  dl.appendChild(el('dd', 'kv-val', value || '-'));
}

function renderDelegation(box, signals) {
  box.appendChild(el('h3', 'sub-title', '// DELEGATION'));
  if (!signals.length) {
    box.appendChild(emptyState('NO SIGNALS'));
    return;
  }
  const table = el('table', 'deleg-table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['POLICY', 'MAIN CALLS', 'DELEGATED', 'VERDICT']) hr.appendChild(el('th', null, h));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const sig of signals) {
    const tr = el('tr');
    tr.appendChild(el('td', 'dg-policy', sig.policy.toUpperCase()));
    tr.appendChild(el('td', 'num', String(sig.main_calls)));
    tr.appendChild(el('td', 'num', String(sig.delegated)));
    const vc = el('td');
    vc.appendChild(verdictPill(sig.verdict));
    tr.appendChild(vc);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  box.appendChild(table);
  box.appendChild(el('p', 'deleg-note',
    'NOTE: the TESTS signal is a coarse proxy - it counts main-context Bash calls by tool name only, not what they ran.'));
}

// Two subtrees on purpose: a live summary replaces .sess-summary and a live event
// prepends into .sess-timeline, so neither path has to rebuild the other.
function renderClaudeSessionDetail() {
  const box = $('#sessionsDetail');
  box.textContent = '';
  addCorners(box);
  const id = state.sessionSel;
  const s = sessionById(id);
  if (!s) { box.appendChild(emptyState('NO SESSION SELECTED')); return; }
  box.appendChild(sessionSummaryBox(s));
  box.appendChild(sessionTimelineBox(id));
}

// Summary-only refresh: leaves the timeline subtree and its scroll position alone.
function patchSessionSummary(s) {
  const old = $('#sessionsDetail .sess-summary');
  if (!old) { renderClaudeSessionDetail(); return; }
  old.replaceWith(sessionSummaryBox(s));
}

function sessionSummaryBox(s) {
  const box = el('div', 'sess-summary');
  const head = el('div', 'detail-head');
  head.appendChild(el('h2', 'section-title', '// ' + sessionLabel(s)));
  const hm = el('div', 'detail-head-meta');
  hm.appendChild(surfaceBadge(s.surface));
  hm.appendChild(sessionStatusPill(s.status));
  head.appendChild(hm);
  box.appendChild(head);

  const dl = el('dl', 'kv');
  kvRow(dl, 'PROJECT', s.project);
  kvRow(dl, 'CWD', s.cwd);
  kvRow(dl, 'BRANCH', s.git_branch);
  kvRow(dl, 'SURFACE', s.surface);
  kvRow(dl, 'SESSION', s.session_id);
  kvRow(dl, 'STARTED', fmtRel(tsMs(s.started)));
  kvRow(dl, 'LAST ACTIVITY', fmtRel(s.ms));
  box.appendChild(dl);

  const stats = el('div', 'sess-stats');
  for (const [label, val] of [['TURNS', String(s.turns)], ['TOOL CALLS', String(s.tool_calls)],
    ['DISPATCHES', String(s.dispatches)], ['TOKENS', fmtCompact(s.tokens)]]) {
    const cell = el('div', 'stat');
    cell.appendChild(el('span', 'stat-label', label));
    cell.appendChild(el('span', 'stat-val num', val));
    stats.appendChild(cell);
  }
  box.appendChild(stats);

  box.appendChild(el('h3', 'sub-title', '// AGENTS USED'));
  if (!s.agents.length) {
    box.appendChild(emptyState('NO AGENTS DISPATCHED'));
  } else {
    for (const a of s.agents.slice(0, DETAIL_LIST_CAP)) {
      box.appendChild(agentRow(a.agentType, a.count, a.model, tsMs(a.lastSeen), isLoopAgent(a.agentType), 'dispatches from this session'));
    }
    moreNote(box, s.agents.length - DETAIL_LIST_CAP);
  }

  renderSessionTasks(box, s.session_id);
  renderDelegation(box, s.compliance.signals);
  return box;
}

// What this session actually dispatched, newest first: the same work items the ACTIVITY
// panel lists, filtered to this session. Computed fresh rather than read from the
// snapshot, because the pane renders right after a session's history is fetched.
function renderSessionTasks(box, id) {
  box.appendChild(el('h3', 'sub-title', '// TASKS'));
  const items = activityItems().filter((i) => i.kind === 'session' && i.sourceId === id);
  if (!items.length) {
    box.appendChild(emptyState('NO DISPATCHED WORK'));
    return;
  }
  for (const item of items.slice(0, DETAIL_LIST_CAP)) {
    const row = el('div', 'stask-row');
    const head = el('div', 'stask-head');
    head.appendChild(el('span', 'stask-agent' + (isLoopAgent(item.agent) ? '' : ' amb'), displayAgent(item.agent)));
    if (item.running) head.appendChild(el('span', 'hud-chip', 'RUNNING'));
    const rel = el('span', 'stask-rel num', fmtRel(item.ms));
    if (item.ms != null) rel.dataset.ts = String(item.ms);
    head.appendChild(rel);
    row.appendChild(head);
    const desc = el('div', 'stask-desc', item.desc);
    desc.title = item.desc;
    row.appendChild(desc);
    box.appendChild(row);
  }
  moreNote(box, items.length - DETAIL_LIST_CAP);
}

function sessionTimelineBox(id) {
  const box = el('div', 'sess-timeline');
  box.appendChild(el('h3', 'sub-title', '// TIMELINE'));
  const detail = state.sessionDetails.get(id);
  if (!detail) {
    box.appendChild(emptyState('LOADING SESSION EVENTS'));
    return box;
  }
  const events = detail.events || [];
  if (!events.length) {
    box.appendChild(emptyState('NO EVENTS'));
    return box;
  }
  for (const ev of events.slice(0, FEED_DOM_CAP)) box.appendChild(sessionEventRow(ev));
  return box;
}

function sessionEventRow(ev) {
  const row = el('div', 'sev-row');
  row.appendChild(el('span', 'sev-type', ev.type));
  const route = el('span', 'sev-route');
  route.appendChild(el('span', 'actor', ev.actor || '-'));
  route.appendChild(el('span', 'arrow', ' -> '));
  route.appendChild(el('span', 'target', ev.target || '-'));
  row.appendChild(route);
  const sum = el('span', 'sev-sum', ev.summary);
  sum.title = ev.summary;
  row.appendChild(sum);
  const rel = el('span', 'rel num', fmtRel(ev.ms));
  if (ev.ms != null) rel.dataset.ts = String(ev.ms);
  row.appendChild(rel);
  return row;
}

// Live event on the shown session: add the one row instead of rebuilding the pane,
// so the reader's scroll survives.
function prependSessionEventRow(ev) {
  const box = $('#sessionsDetail .sess-timeline');
  if (!box) return;
  const empty = $('.empty', box);
  if (empty) empty.remove();
  const scroller = $('#sessionsDetail');
  const first = $('.sev-row', box);
  // Scroll anchoring does not save this pane (measured: a reader scrolled into the
  // timeline drifts one row per event), so compensate the same way #commsFeed does.
  // Only when the insert lands above the viewport: with the timeline's head on
  // screen the reader should see the row arrive, not have it scrolled away.
  const above = (first || box).getBoundingClientRect().top < scroller.getBoundingClientRect().top;
  const heightBefore = scroller.scrollHeight;
  const row = sessionEventRow(ev);
  if (first) box.insertBefore(row, first);
  else box.appendChild(row);
  // Measured before the tail trim: trimming drops rows below the reader, which
  // changes scrollHeight without shifting anything they are looking at.
  const grew = scroller.scrollHeight - heightBefore;
  const rows = $$('.sev-row', box);
  for (let i = FEED_DOM_CAP; i < rows.length; i++) rows[i].remove();
  if (above) scroller.scrollTop += grew;
}

/* ---------------- log modal ---------------- */

async function openLog(runId, n, file) {
  const modal = $('#modal');
  $('#modalTitle').textContent = runId + ' / iter ' + n + ' / ' + file;
  const pre = $('#modalPre');
  pre.textContent = 'LOADING ...';
  modal.hidden = false;
  $('#modalClose').focus();
  try {
    const res = await fetch('/api/runs/' + encodeURIComponent(runId) + '/logs/' + encodeURIComponent(n) + '/' + encodeURIComponent(file));
    const txt = await res.text();
    pre.textContent = res.ok ? txt.replace(/^\uFEFF/, '') : 'HTTP ' + res.status + ' :: ' + txt;
  } catch (e) {
    pre.textContent = 'FETCH FAILED :: ' + esc(e && e.message);
  }
}

function wireModal() {
  const modal = $('#modal');
  $('#modalClose').addEventListener('click', () => { modal.hidden = true; });
  $('.modal-scrim', modal).addEventListener('click', () => { modal.hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) modal.hidden = true;
  });
}

/* ---------------- views / nav ---------------- */

const VIEWS = ['fleet', 'comms', 'graph', 'sessions'];
const VIEW_KEY = 'hc.view';

// Remember the last tab so a refresh does not always dump the user back on Graph.
// localStorage can throw in private mode or under file://; a missing/invalid value falls back.
function restoreView() {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v && VIEWS.includes(v)) return v;
  } catch (e) { /* storage unavailable */ }
  return 'graph';
}

function setView(v) {
  state.view = v;
  try { localStorage.setItem(VIEW_KEY, v); } catch (e) { /* storage unavailable */ }
  for (const sec of $$('.view')) sec.classList.toggle('active', sec.id === 'view-' + v);
  for (const btn of $$('.rail-btn')) {
    if (!btn.dataset.view) continue; // #chatBtn's active state tracks the dock, not the view
    btn.classList.toggle('active', btn.dataset.view === v);
  }
  if (v === 'fleet') renderFleet();
  else if (v === 'comms') {
    renderComms();
    if (state.commsRunId && !state.details.has(state.commsRunId)) {
      ensureDetail(state.commsRunId).then(renderComms).catch(() => {});
    }
  } else if (v === 'sessions') {
    renderSessions();
    if (state.sessionsSel && !state.details.has(state.sessionsSel)) {
      ensureDetail(state.sessionsSel).then(renderSessions).catch(() => {});
    }
    if (state.detailKind === 'session' && state.sessionSel && !state.sessionDetails.has(state.sessionSel)) {
      ensureSessionDetail(state.sessionSel).then(renderSessions).catch(() => {});
    }
  } else if (v === 'graph') updateGraph();
}

/* ---------------- chat dock (fly-up Albert Chat) ---------------- */

// Albert Chat is a separate local service (Chainlit on 4401); this console stays a
// read-only monitor. The iframe talks to that service directly from the browser, so
// nothing here writes through the console server. The dock floats over whatever view is
// active and only toggles CSS classes, never detaching the iframe: the websocket and the
// conversation survive closing and reopening it. The src is set lazily on first open, so
// the console never touches 4401 unless the dock is used.
const CHAT_URL = 'http://127.0.0.1:4401/';
let chatLoaded = false;

function ensureChat() {
  const frame = $('#chatFrame');
  const offline = $('#chatOffline');
  if (!frame || !offline || chatLoaded) return;
  // no-cors probe: an opaque response means the service is up; only a network-level
  // failure (nothing listening) rejects.
  fetch(CHAT_URL, { mode: 'no-cors', cache: 'no-store' })
    .then(() => {
      chatLoaded = true;
      frame.src = CHAT_URL;
      frame.hidden = false;
      offline.hidden = true;
    })
    .catch(() => {
      frame.hidden = true;
      offline.hidden = false;
    });
}

function toggleChat(force) {
  const dock = $('#chatDock');
  const btn = $('#chatBtn');
  if (!dock) return;
  const show = force !== undefined ? force : !dock.classList.contains('open');
  dock.classList.toggle('open', show);
  if (btn) {
    btn.classList.toggle('active', show);
    btn.setAttribute('aria-expanded', String(show));
  }
  if (show) ensureChat();
}

function wireChat() {
  const btn = $('#chatBtn');
  if (btn) btn.addEventListener('click', () => toggleChat());
  const close = $('#chatClose');
  if (close) close.addEventListener('click', () => toggleChat(false));
  const retry = $('#chatRetry');
  if (retry) retry.addEventListener('click', ensureChat);
}

function wireNav() {
  for (const btn of $$('.rail-btn')) {
    if (!btn.dataset.view) continue; // #chatBtn toggles the dock, not a view
    btn.addEventListener('click', () => setView(btn.dataset.view));
  }
}

function renderAll() {
  renderTopbar();
  if (state.view === 'fleet') renderFleet();
  if (state.view === 'comms') renderComms();
  if (state.view === 'sessions') renderSessions();
  updateGraph();
}

/* ---------------- SSE ---------------- */

let indexRefreshTimer = null;

// Fetch the detail behind whatever the panes currently point at. applyRuns can
// repoint activeRunId / commsRunId / sessionsSel at a run that was never fetched,
// and the panes read straight from state.details / state.feeds: without this they
// sit on 'LOADING RUN DATA' / 'AWAITING TELEMETRY' until the user navigates away
// and back, since setView is the only other caller of ensureDetail.
function hydrateShown() {
  const shown = new Set([state.activeRunId, state.commsRunId, state.sessionsSel]);
  for (const id of shown) {
    if (id && !state.details.has(id)) ensureDetail(id).then(renderAll).catch(() => {});
  }
  if (state.detailKind === 'session' && state.sessionSel && !state.sessionDetails.has(state.sessionSel)) {
    ensureSessionDetail(state.sessionSel).then(renderAll).catch(() => {});
  }
}

// Index-level broadcasts (a new run registered, a new session observed) carry no
// run_id. They used to be dropped, so a new run/session could not appear without a
// page reload; refetch the lists instead. Debounced: a burst of watcher events on
// one index write must not fan out into a request stampede.
function refreshIndex() {
  if (indexRefreshTimer) return;
  indexRefreshTimer = setTimeout(() => {
    indexRefreshTimer = null;
    Promise.all([
      fetchJSON('/api/runs').then(applyRuns).catch(() => {}),
      fetchSessions(),
    ]).then(() => {
      renderAll();
      hydrateShown();
    }).catch(() => {});
  }, 150);
}

function applyStateUpdate(msg) {
  if (!msg) return;
  if (!msg.run_id) { refreshIndex(); return; }
  const run = state.runs.find((r) => r.id === msg.run_id);
  if (run && msg.progress) {
    run.progress = msg.progress;
    run.status = msg.progress.status || run.status;
  }
  const detail = state.details.get(msg.run_id);
  if (detail && msg.progress) detail.progress = msg.progress;
  renderTopbar();
  updateGraph();
  if (state.view === 'sessions') renderSessions();
  if (state.view === 'fleet') patchFleet();
}

let streamRetryMs = 2000;

function openStream() {
  const es = new EventSource('/events');
  es.onopen = () => { state.connected = true; streamRetryMs = 2000; renderTopbar(); };
  es.onerror = () => {
    state.connected = false;
    renderTopbar();
    // EventSource retries transient failures itself, but gives up for good
    // (readyState CLOSED) on a non-200 or wrong Content-Type; rebuild it then.
    if (es.readyState === EventSource.CLOSED) {
      es.close();
      setTimeout(openStream, streamRetryMs);
      streamRetryMs = Math.min(streamRetryMs * 2, 30000);
    }
  };
  es.addEventListener('init', (e) => {
    const snap = safeParse(e.data);
    if (!snap) return;
    const rosterList = Array.isArray(snap.roster) ? snap.roster : (snap.roster && snap.roster.agents) || [];
    if (rosterList.length) applyRoster(rosterList);
    // Present only when the server already had a cached reading; the poll fills it in
    // otherwise, so this never delays the snapshot.
    if (snap.usage) { state.usage = normUsage(snap.usage); renderUsage(); }
    const runsList = Array.isArray(snap.runs) ? snap.runs : (snap.runs && snap.runs.runs) || [];
    applyRuns({ active_run_id: snap.active_run_id, runs: runsList });
    if (snap.sessions) applySessions(snap.sessions);
    // A reconnect may have missed events.jsonl lines and progress updates, so
    // cached details and feeds are stale; drop them and refetch what is shown.
    state.details.clear();
    state.feeds.clear();
    state.sessionDetails.clear();
    buildGraph();
    renderAll();
    hydrateShown();
  });
  es.addEventListener('harness', (e) => {
    const ev = safeParse(e.data);
    if (ev) ingestLive(ev);
  });
  es.addEventListener('state', (e) => {
    const msg = safeParse(e.data);
    if (msg) applyStateUpdate(msg);
  });
  es.addEventListener('session', (e) => {
    const ev = safeParse(e.data);
    if (ev) ingestSessionEvent(ev);
  });
  es.addEventListener('session-state', (e) => {
    const msg = safeParse(e.data);
    if (msg) applySessionState(msg);
  });
}

/* ---------------- tick (relative time refresh) ---------------- */

function tick() {
  for (const n of $$('[data-ts]')) n.textContent = fmtRel(Number(n.dataset.ts));
  if (state.view === 'fleet') patchFleet();
  updateGraph();
}

/* ---------------- boot ---------------- */

async function boot() {
  wireNav();
  wireModal();
  wireChat();
  applyRoster([]); // synthetic albert until roster arrives, keeps graph core meaningful
  try {
    const [roster, runs] = await Promise.all([
      fetchJSON('/api/roster'),
      fetchJSON('/api/runs'),
      fetchSessions(), // swallows its own errors: sessions are optional to boot
    ]);
    applyRoster(roster.agents || []);
    applyRuns(runs);
    if (state.activeRunId) await ensureDetail(state.activeRunId);
  } catch (e) {
    // API unreachable: views render themed empty states, SSE will retry
  }
  buildGraph();
  renderTopbar();
  updateGraph();          // keep the (possibly hidden) graph warm regardless of the restored tab
  setView(restoreView()); // land on the tab the user last had open, not always Graph
  openStream();
  setInterval(tick, 5000);
  fetchUsage();
  setInterval(fetchUsage, USAGE_POLL_MS);
}

boot();
