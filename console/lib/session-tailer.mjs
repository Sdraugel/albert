// Session tailer: mirrors every Claude Code session by tailing Claude Code's own
// transcripts. No hooks, strictly read-only - this module opens files 'r' and
// never writes to ~/.claude/projects or the run store.
//
// PRIVACY: this module never sees raw transcript text. Every line goes through
// transcript-adapter.parseLine first, so only allowlisted fields exist here. Any
// change that reads a jsonl line without the adapter is a privacy bug.
//
// EPHEMERALITY: ~/.claude/projects/.last-cleanup proves Claude Code prunes this
// directory on its own schedule. Transcripts are a LIVE FEED to mirror, never
// durable history: once a session is seen it stays in memory (marked `missing`
// if its file vanishes), but nothing is persisted to disk.
//
// SESSION DEATH IS INFERRED. There is no SessionEnd signal by design, so `idle`
// means "no new bytes for 10 minutes", NOT "exited". Never claim exactness.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { parseLine, toSurface } from './transcript-adapter.mjs';

const IDLE_MS = 10 * 60 * 1000;
const RECENT_MS = 24 * 60 * 60 * 1000;
const DEBOUNCE_MS = 200;
const POLL_MS = 5000;
const RECONCILE_MS = 60000;
const MAX_EVENTS = 2000;
const MAX_SESSION_EVENTS = 500;
const READ_CHUNK = 1 << 22; // 4 MiB: bounds RSS on the 52 MB transcript

// Main-context tool names that feed the compliance signals. Names only - the
// adapter never exposes inputs, so `Bash` cannot be narrowed to test commands.
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);
const DOC_TOOLS = new Set(['Write', 'Edit']);
const TEST_TOOLS = new Set(['Bash']);

const POLICY_DELEGATES = {
  search: 'codebase-locator',
  tests: 'test-runner',
  docs: 'doc-writer',
};

/**
 * verdict per spec: followed if delegated>0 && main<=delegated*2;
 * ignored if delegated===0 && main>=5; n/a if both zero; else mixed.
 */
function toVerdict(mainCalls, delegated) {
  if (mainCalls === 0 && delegated === 0) return 'n/a';
  if (delegated > 0 && mainCalls <= delegated * 2) return 'followed';
  if (delegated === 0 && mainCalls >= 5) return 'ignored';
  return 'mixed';
}

function toMillis(iso) {
  if (typeof iso !== 'string') return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export function createSessionTailer({ projectsRoot, onEvent, onSessionUpdate, logger } = {}) {
  const root = projectsRoot;
  const log = logger && typeof logger.warn === 'function' ? logger : console;
  const emitEvent = typeof onEvent === 'function' ? onEvent : () => {};
  const emitUpdate = typeof onSessionUpdate === 'function' ? onSessionUpdate : () => {};

  /** sessionId -> internal state */
  const sessions = new Map();
  /** absolute file path -> sessionId (a file may be renamed/pruned) */
  const fileToSession = new Map();
  /** global event ring, newest last */
  const events = [];
  /** log once per distinct problem, never per line */
  const loggedProblems = new Set();

  let started = false;
  let backfilling = false;
  let watcher = null;
  let debounceTimer = null;
  let pollTimer = null;
  let reconcileTimer = null;
  const pendingFiles = new Set();

  function problem(key, message) {
    if (loggedProblems.has(key)) return;
    loggedProblems.add(key);
    try {
      log.warn(`[session-tailer] ${message}`);
    } catch {
      /* a broken logger must not take down the tailer */
    }
  }

  // ---------------- session state ----------------

  function newCompliance() {
    return {
      searchMain: 0,
      searchDelegated: 0,
      testsMain: 0,
      testsDelegated: 0,
      docsMain: 0,
      docsDelegated: 0,
    };
  }

  function newState(sessionId, file) {
    return {
      sessionId,
      file,
      offset: 0,
      cwd: null,
      gitBranch: null,
      entrypoint: null,
      title: null,
      started: null,
      lastActivity: null,
      lastActivityMs: 0,
      status: 'idle',
      missing: false,
      // Tracked on the state, not inferred from map membership: a file first seen
      // at 0 bytes registers a state before it has any records to apply.
      startEmitted: false,
      // True only while a rewritten file is being re-counted from the top.
      replaying: false,
      turns: 0,
      toolCalls: 0,
      dispatches: 0,
      // Subagent tokens, reported by each dispatch result.
      tokens: 0,
      // Main-thread tokens, from message.usage on assistant lines. Disjoint from the
      // subagent total above: subagent work is not written to this transcript at all
      // (measured: zero sidechain assistant lines in 73 live files), so the two add up
      // without double counting.
      mainTokens: 0,
      // Cache reads are kept apart because they dominate raw volume (measured 566M of
      // 592M over the six newest transcripts) and would drown every other number.
      cacheReadTokens: 0,
      // 'YYYY-MM-DD' in LOCAL time -> { billable, cacheRead, byAgent: Map }
      days: new Map(),
      // agentType -> { count, lastSeen, model }
      agents: new Map(),
      // toolUseId -> { subagentType, description } for deriving result labels
      pending: new Map(),
      compliance: newCompliance(),
      dirty: false,
    };
  }

  /**
   * Claude Code compaction rewrites a transcript in place, so the bytes every
   * counter below was derived from no longer exist. Rewinding the offset alone
   * would add the whole replayed file on top of the stale totals, so rebuild the
   * derived state instead. Identity (sessionId, file, cwd, branch, title,
   * started, last activity) survives: it describes the session, not the bytes.
   */
  function resetDerived(state) {
    state.offset = 0;
    state.replaying = true;
    state.turns = 0;
    state.toolCalls = 0;
    state.dispatches = 0;
    state.tokens = 0;
    state.mainTokens = 0;
    state.cacheReadTokens = 0;
    // Rebuilt from the replayed bytes like every other counter, so a compaction can
    // never fold the same day's tokens in twice.
    state.days = new Map();
    state.agents = new Map();
    state.pending = new Map();
    state.compliance = newCompliance();
    state.dirty = true;
  }

  function projectOf(state) {
    return state.cwd ? path.basename(state.cwd) : null;
  }

  /* ---------------- token burn (local, measured from these transcripts) ---------------- */

  const BURN_DAYS = 8;
  const MAIN_AGENT_KEY = 'main-thread';

  // Local calendar day, so "today" means the reader's today rather than UTC's.
  function dayKey(ms) {
    const d = new Date(ms);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function recentDayKeys(n) {
    const out = [];
    const now = new Date();
    for (let i = 0; i < n; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      out.push(dayKey(d.getTime()));
    }
    return out;
  }

  // A few numbers per day per session, pruned to the last BURN_DAYS so an old session
  // cannot grow a map for every day it ever ran.
  function addBurn(state, tsMs, agentType, billable, cacheRead) {
    if (!billable && !cacheRead) return;
    const key = dayKey(tsMs);
    let day = state.days.get(key);
    if (!day) {
      day = { billable: 0, cacheRead: 0, byAgent: new Map() };
      state.days.set(key, day);
      if (state.days.size > BURN_DAYS) {
        const keep = new Set(recentDayKeys(BURN_DAYS));
        keep.add(key);
        for (const k of state.days.keys()) if (!keep.has(k)) state.days.delete(k);
      }
    }
    day.billable += billable;
    day.cacheRead += cacheRead;
    if (billable) day.byAgent.set(agentType, (day.byAgent.get(agentType) || 0) + billable);
    state.dirty = true;
  }

  // Main-thread usage. The headline number is input + output + cache CREATION: those
  // are the tokens the work actually cost. Cache READS are counted separately, never
  // folded in, because re-reading a cached context every turn is 96% of raw volume and
  // would make every other figure meaningless.
  function applyMainUsage(state, rec) {
    const u = rec.usage;
    if (!u) return;
    const billable = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const cacheRead = u.cache_read_input_tokens || 0;
    if (!billable && !cacheRead) return;
    state.mainTokens += billable;
    state.cacheReadTokens += cacheRead;
    state.dirty = true;
    addBurn(state, toMillis(rec.timestamp) || Date.now(), MAIN_AGENT_KEY, billable, cacheRead);
  }

  function toSummary(state) {
    const signals = [
      {
        policy: 'search',
        main_calls: state.compliance.searchMain,
        delegated: state.compliance.searchDelegated,
        verdict: toVerdict(state.compliance.searchMain, state.compliance.searchDelegated),
      },
      {
        policy: 'tests',
        main_calls: state.compliance.testsMain,
        delegated: state.compliance.testsDelegated,
        verdict: toVerdict(state.compliance.testsMain, state.compliance.testsDelegated),
        // Bash-count proxy: the adapter forbids reading command strings, so this
        // cannot distinguish a test run from `ls`. The UI must label it a proxy.
        proxy: true,
      },
      {
        policy: 'docs',
        main_calls: state.compliance.docsMain,
        delegated: state.compliance.docsDelegated,
        verdict: toVerdict(state.compliance.docsMain, state.compliance.docsDelegated),
      },
    ];

    const agents = [];
    for (const [agentType, a] of state.agents) {
      agents.push({ agentType, count: a.count, lastSeen: a.lastSeen, model: a.model });
    }
    agents.sort((x, y) => y.count - x.count);

    // A session that dispatched any loop-* agent IS an /albert harness run,
    // even when the run store never recorded it. Derived only from the already-
    // tracked structured agent types - no transcript body, prompt, or tool input
    // is consulted, so the privacy allowlist is untouched.
    const harnessAgents = [];
    for (const agentType of state.agents.keys()) {
      if (typeof agentType === 'string' && agentType.startsWith('loop-')) harnessAgents.push(agentType);
    }
    harnessAgents.sort();

    return {
      session_id: state.sessionId,
      project: projectOf(state),
      cwd: state.cwd,
      git_branch: state.gitBranch,
      surface: toSurface(state.entrypoint),
      title: state.title,
      started: state.started,
      last_activity: state.lastActivity,
      status: state.status,
      turns: state.turns,
      tool_calls: state.toolCalls,
      dispatches: state.dispatches,
      // Lifetime total: main thread PLUS subagents. This used to be subagent-only,
      // which undercounted every session that did its own work.
      tokens: state.tokens + state.mainTokens,
      agents,
      // Derived from `agents` above; both are booleans/strings, never free text.
      is_harness: harnessAgents.length > 0,
      harness_agents: harnessAgents,
      compliance: { signals },
      // Required mark: projects/ is pruned by Claude Code, so a vanished file is
      // normal. Additive to the fixed shape; every contract field is still present.
      missing: state.missing,
    };
  }

  function pushEvent(state, type, fields) {
    // A replay re-reads records that were already reported (see resetDerived).
    // The counters must be rebuilt from those bytes, but the events they
    // describe are already in the ring: pushing them again would show duplicate
    // dispatches in the Comms feed for work that finished long ago.
    if (state.replaying) return null;
    const ev = {
      ts: fields.ts || state.lastActivity || new Date().toISOString(),
      session_id: state.sessionId,
      project: projectOf(state),
      type,
      actor: fields.actor,
      target: fields.target ?? null,
      summary: fields.summary,
      data: fields.data ?? {},
    };
    events.push(ev);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    // During backfill the ring is populated for history, but listeners are not
    // called: 71 sessions of replayed history would flood SSE at boot.
    if (!backfilling) {
      try {
        emitEvent(ev);
      } catch (e) {
        problem('onEvent', `onEvent handler threw: ${e.message}`);
      }
    }
    return ev;
  }

  function flushUpdate(state) {
    if (!state.dirty) return;
    state.dirty = false;
    if (backfilling) return;
    try {
      emitUpdate(toSummary(state));
    } catch (e) {
      problem('onSessionUpdate', `onSessionUpdate handler threw: ${e.message}`);
    }
  }

  // ---------------- record application ----------------

  function touch(state, rec) {
    const ms = toMillis(rec.timestamp);
    if (ms === null) return;
    if (ms > state.lastActivityMs) {
      state.lastActivityMs = ms;
      state.lastActivity = rec.timestamp;
      state.dirty = true;
    }
    if (state.started === null || ms < toMillis(state.started)) {
      state.started = rec.timestamp;
      state.dirty = true;
    }
  }

  function applyRecord(state, rec) {
    // Sidechain lines are subagent context. Measured 0 in top-level files, but
    // main-context counters must stay honest if that ever changes.
    const isMain = rec.isSidechain !== true;

    if (rec.cwd && state.cwd !== rec.cwd) {
      state.cwd = rec.cwd;
      state.dirty = true;
    }
    if (rec.gitBranch && state.gitBranch !== rec.gitBranch) {
      state.gitBranch = rec.gitBranch;
      state.dirty = true;
    }
    if (rec.entrypoint && state.entrypoint !== rec.entrypoint) {
      state.entrypoint = rec.entrypoint;
      state.dirty = true;
    }
    touch(state, rec);

    if (rec.kind === 'title') {
      if (rec.aiTitle && rec.aiTitle !== state.title) {
        state.title = rec.aiTitle;
        state.dirty = true;
        pushEvent(state, 'session.title', {
          ts: rec.timestamp,
          actor: 'claude-code',
          target: null,
          summary: `titled: ${rec.aiTitle}`,
          data: { title: rec.aiTitle },
        });
      }
      return;
    }

    if (rec.kind === 'user-turn') {
      if (isMain) {
        state.turns++;
        state.dirty = true;
      }
      return;
    }

    // Every assistant line carries usage, whatever else it is doing.
    if (isMain && rec.usage) applyMainUsage(state, rec);

    if (rec.kind === 'meta') return;

    if (rec.kind === 'tool-call' || rec.kind === 'dispatch') {
      if (isMain && Array.isArray(rec.toolCalls)) {
        for (const c of rec.toolCalls) {
          state.toolCalls++;
          if (SEARCH_TOOLS.has(c.toolName)) state.compliance.searchMain++;
          else if (TEST_TOOLS.has(c.toolName)) state.compliance.testsMain++;
          else if (DOC_TOOLS.has(c.toolName)) state.compliance.docsMain++;
        }
        state.dirty = true;
      }
      if (Array.isArray(rec.dispatches)) {
        for (const d of rec.dispatches) {
          state.dispatches++;
          state.dirty = true;
          const type = d.subagentType || 'unknown';
          if (type === POLICY_DELEGATES.search) state.compliance.searchDelegated++;
          else if (type === POLICY_DELEGATES.tests) state.compliance.testsDelegated++;
          else if (type === POLICY_DELEGATES.docs) state.compliance.docsDelegated++;
          if (d.toolUseId) state.pending.set(d.toolUseId, d);
          // An agent has to become visible the moment it is SPUN UP, not when it
          // finishes: lastSeen drives the Fleet heartbeat and the Graph lighting, so
          // updating it only on the result made a currently-running agent invisible for
          // its whole (often multi-minute) run. count is incremented here, at dispatch,
          // and deliberately NOT again on the result, or every agent would count twice.
          const prevDispatch = state.agents.get(type);
          state.agents.set(type, {
            count: (prevDispatch?.count || 0) + 1,
            lastSeen: rec.timestamp || prevDispatch?.lastSeen || null,
            model: prevDispatch?.model || null,
          });
          pushEvent(state, 'agent.dispatched', {
            ts: rec.timestamp,
            actor: 'claude-code',
            target: type,
            summary: d.description
              ? `dispatched ${type}: ${d.description}`
              : `dispatched ${type}`,
            data: { agentType: type, description: d.description, toolUseId: d.toolUseId },
          });
        }
      }
      return;
    }

    if (rec.kind === 'dispatch-result') {
      const r = rec.result;
      // The result stands alone: 3 of 282 results have no dispatch line in any
      // live file (resumed/pruned session), so agentType comes off the result
      // itself and correlation is a bonus, never a requirement.
      const pending = r.toolUseId ? state.pending.get(r.toolUseId) : null;
      const type = r.agentType || pending?.subagentType || 'unknown';
      if (r.toolUseId) state.pending.delete(r.toolUseId);

      if (typeof r.totalTokens === 'number') {
        state.tokens += r.totalTokens;
        state.dirty = true;
        // Attributed to the agent that spent them, on the day it reported back.
        addBurn(state, toMillis(rec.timestamp) || Date.now(), type, r.totalTokens, 0);
      }

      const prev = state.agents.get(type);
      state.agents.set(type, {
        // Counted at dispatch, not here. A result with no dispatch line in any live
        // file (resumed or pruned session) still counts as one.
        count: prev?.count || 1,
        lastSeen: rec.timestamp || prev?.lastSeen || null,
        model: r.resolvedModel || prev?.model || null,
      });
      state.dirty = true;

      const ok = r.status === 'completed';
      const label = pending?.description ? `${type}: ${pending.description}` : type;
      pushEvent(state, ok ? 'agent.done' : 'agent.failed', {
        ts: rec.timestamp,
        actor: type,
        target: 'claude-code',
        summary: ok ? `completed ${label}` : `failed ${label} (${r.status || 'unknown status'})`,
        data: {
          agentType: type,
          agentId: r.agentId,
          status: r.status,
          model: r.resolvedModel,
          durationMs: r.totalDurationMs,
          tokens: r.totalTokens,
          toolUseCount: r.totalToolUseCount,
        },
      });
    }
  }

  // ---------------- file reading ----------------

  /**
   * Read complete lines from `state.file` starting at `state.offset`.
   * Advances the offset only past the last \n, so a tail that lands mid-line
   * leaves those bytes for the next read (Claude Code appends whole lines, but
   * a torn read is still possible and must never corrupt a record).
   * Chunked so the 52 MB transcript never lands in memory whole.
   */
  async function readNewLines(state, onRecord) {
    let size;
    try {
      size = (await fsp.stat(state.file)).size;
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        if (!state.missing) {
          state.missing = true;
          state.dirty = true;
          // Expected: Claude Code prunes this directory on its own schedule.
          problem(`gone:${state.file}`, `transcript pruned, keeping session in memory: ${state.sessionId}`);
        }
        return;
      }
      problem(`stat:${state.file}`, `stat failed for ${state.file}: ${e.message}`);
      return;
    }
    if (state.missing) {
      state.missing = false;
      state.dirty = true;
    }
    // Truncated or rewritten (Claude Code compaction): re-count from the top.
    if (size < state.offset) resetDerived(state);

    try {
      if (size === state.offset) return;

      let fh;
      try {
        fh = await fsp.open(state.file, 'r');
      } catch (e) {
        problem(`open:${state.file}`, `open failed for ${state.file}: ${e.message}`);
        return;
      }

      const decoder = new StringDecoder('utf8');
      const buf = Buffer.allocUnsafe(READ_CHUNK);
      let pos = state.offset;
      let consumed = state.offset;
      let carry = '';

      try {
        while (pos < size) {
          const chunkStart = pos;
          const toRead = Math.min(READ_CHUNK, size - pos);
          const { bytesRead } = await fh.read(buf, 0, toRead, pos);
          if (bytesRead <= 0) break;

          // Byte offset of the last newline must come from the BUFFER: a decoded
          // string index would be wrong wherever multi-byte UTF-8 appears.
          const lastNl = buf.lastIndexOf(0x0a, bytesRead - 1);
          // StringDecoder holds back a partial multi-byte char across chunks.
          carry += decoder.write(buf.subarray(0, bytesRead));
          pos += bytesRead;

          if (lastNl !== -1) {
            const parts = carry.split('\n');
            carry = parts.pop() ?? '';
            for (const line of parts) onRecord(line);
            // Absolute byte just past that newline, taken from the buffer's own
            // position. Deriving it by subtracting carry's byte length from
            // `pos` would over-advance on a torn read: the 1-3 bytes of an
            // incomplete multi-byte char are counted in `pos` but held back by
            // the decoder, so they are absent from `carry`. That lands the
            // offset INSIDE the trailing partial line, and since the offset
            // never rewinds, the line is silently lost forever.
            consumed = chunkStart + lastNl + 1;
          }
        }
      } catch (e) {
        problem(`read:${state.file}`, `read failed for ${state.file}: ${e.message}`);
      } finally {
        try {
          await fh.close();
        } catch {
          /* already closed */
        }
      }
      // Trailing bytes without a newline stay unconsumed for the next read.
      state.offset = consumed;
    } finally {
      state.replaying = false;
    }
  }

  function ensureState(sessionId, file) {
    let state = sessions.get(sessionId);
    if (!state) {
      state = newState(sessionId, file);
      sessions.set(sessionId, state);
    }
    state.file = file;
    fileToSession.set(file.toLowerCase(), sessionId);
    return state;
  }

  async function ingestFile(file, { isNew } = {}) {
    const sessionId = path.basename(file, '.jsonl');
    const state = ensureState(sessionId, file);

    let applied = 0;
    let unparseable = 0;
    await readNewLines(state, (line) => {
      if (!line.trim()) return;
      let rec;
      try {
        rec = parseLine(line); // adapter is the only reader of raw text
      } catch (e) {
        // parseLine is contractually non-throwing; belt and braces.
        problem(`parse:${state.file}`, `adapter threw on ${state.sessionId}: ${e.message}`);
        return;
      }
      if (!rec) {
        unparseable++;
        return;
      }
      try {
        applyRecord(state, rec);
        applied++;
      } catch (e) {
        problem(`apply:${state.file}`, `apply failed on ${state.sessionId}: ${e.message}`);
      }
    });

    if (unparseable > 0) {
      problem(
        `unparseable:${state.file}`,
        `${unparseable} unparseable line(s) skipped in ${state.sessionId}`,
      );
    }

    if (!state.startEmitted && applied > 0) {
      // Gated on the state, not on first sight of the file: fs.watch fires on
      // creation before the first write lands (the common live path on Windows),
      // so the pass that registers the session routinely applies 0 records.
      // Synthesized from the first record's envelope; the transcript has no start
      // line of its own. Appended last but stamped with the session's earliest
      // timestamp: the ring is insertion-ordered, so consumers order by `ts`.
      state.startEmitted = true;
      pushEvent(state, 'session.start', {
        ts: state.started || state.lastActivity || new Date().toISOString(),
        actor: 'claude-code',
        target: null,
        summary: state.title ? `session started: ${state.title}` : 'session started',
        data: { surface: toSurface(state.entrypoint), cwd: state.cwd, git_branch: state.gitBranch },
      });
      state.dirty = true;
    }

    refreshStatus(state);
    flushUpdate(state);
    void isNew;
  }

  /** Status is INFERRED from byte arrival, never from an exit signal. */
  function refreshStatus(state) {
    const next = Date.now() - state.lastActivityMs < IDLE_MS ? 'active' : 'idle';
    if (next === state.status) return;
    const wasActive = state.status === 'active';
    state.status = next;
    state.dirty = true;
    if (next === 'idle' && wasActive) {
      pushEvent(state, 'session.idle', {
        ts: new Date().toISOString(),
        actor: 'claude-code',
        target: null,
        // Inferred, not observed: no SessionEnd hook exists by design.
        summary: 'no activity for 10m (idle inferred, not an exit signal)',
        data: { last_activity: state.lastActivity },
      });
    }
  }

  // ---------------- scanning ----------------

  /** Top-level <slug>/<sessionId>.jsonl only. subagents/ subtrees are redundant and huge. */
  async function scanFiles() {
    const found = [];
    let dirs;
    try {
      dirs = await fsp.readdir(root, { withFileTypes: true });
    } catch (e) {
      problem('root', `cannot read projectsRoot ${root}: ${e.message}`);
      return found;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dir = path.join(root, d.name);
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (e) {
        problem(`dir:${dir}`, `cannot read ${dir}: ${e.message}`);
        continue;
      }
      for (const f of entries) {
        if (f.isFile() && f.name.endsWith('.jsonl')) found.push(path.join(dir, f.name));
      }
    }
    return found;
  }

  async function backfill() {
    backfilling = true;
    try {
      const files = await scanFiles();
      for (const file of files) {
        try {
          await ingestFile(file, { isNew: false });
        } catch (e) {
          problem(`backfill:${file}`, `backfill failed for ${file}: ${e.message}`);
        }
      }
    } finally {
      backfilling = false;
    }
  }

  async function processPending() {
    const batch = [...pendingFiles];
    pendingFiles.clear();
    for (const file of batch) {
      try {
        await ingestFile(file, { isNew: !fileToSession.has(file.toLowerCase()) });
      } catch (e) {
        problem(`ingest:${file}`, `ingest failed for ${file}: ${e.message}`);
      }
    }
  }

  function queueFile(file) {
    pendingFiles.add(file);
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      // Coalescing is harmless: every read is a stat-and-seek from the stored
      // offset, so N events for one file collapse into one incremental read.
      processPending().catch((e) => problem('pending', `pending flush failed: ${e.message}`));
    }, DEBOUNCE_MS);
    if (typeof debounceTimer.unref === 'function') debounceTimer.unref();
  }

  function startWatch() {
    try {
      // A HINT ONLY: fs.watch drops events under load, hence the poll + reconcile
      // safety nets below.
      watcher = fs.watch(root, { recursive: true }, (_type, filename) => {
        if (!filename) return;
        const rel = filename.toString();
        const parts = rel.split(/[\\/]/).filter(Boolean);
        // <slug>/<sessionId>.jsonl only: ignore the subagents/ subtree.
        if (parts.length !== 2) return;
        if (!parts[1].endsWith('.jsonl')) return;
        queueFile(path.join(root, rel));
      });
      watcher.on('error', (e) => problem('watch', `watch error on ${root}: ${e.message}`));
    } catch (e) {
      problem('watch', `watch failed for ${root}: ${e.message} (falling back to polling)`);
    }
  }

  /** Safety net 1: stat-poll recently-active sessions in case watch missed them. */
  async function pollRecent() {
    const now = Date.now();
    for (const state of sessions.values()) {
      if (state.missing) continue;
      if (now - state.lastActivityMs > RECENT_MS) {
        // Too old to grow, but status can still flip active -> idle.
        refreshStatus(state);
        flushUpdate(state);
        continue;
      }
      try {
        const size = (await fsp.stat(state.file)).size;
        if (size !== state.offset) await ingestFile(state.file, { isNew: false });
        else {
          refreshStatus(state);
          flushUpdate(state);
        }
      } catch (e) {
        if (e && e.code === 'ENOENT') {
          if (!state.missing) {
            state.missing = true;
            state.dirty = true;
            flushUpdate(state);
          }
          continue;
        }
        problem(`poll:${state.file}`, `poll failed for ${state.file}: ${e.message}`);
      }
    }
  }

  /** Safety net 2: full rescan picks up brand-new session files. */
  async function reconcile() {
    const files = await scanFiles();
    for (const file of files) {
      const known = fileToSession.has(file.toLowerCase());
      if (!known) queueFile(file);
    }
  }

  return {
    async start() {
      if (started) return;
      started = true;
      await backfill();
      startWatch();
      pollTimer = setInterval(() => {
        pollRecent().catch((e) => problem('poll', `poll cycle failed: ${e.message}`));
      }, POLL_MS);
      reconcileTimer = setInterval(() => {
        reconcile().catch((e) => problem('reconcile', `reconcile cycle failed: ${e.message}`));
      }, RECONCILE_MS);
      // Don't hold the process open on the tailer's account.
      if (typeof pollTimer.unref === 'function') pollTimer.unref();
      if (typeof reconcileTimer.unref === 'function') reconcileTimer.unref();
    },

    stop() {
      started = false;
      if (watcher) {
        try {
          watcher.close();
        } catch {
          /* already closed */
        }
        watcher = null;
      }
      if (debounceTimer) clearTimeout(debounceTimer);
      if (pollTimer) clearInterval(pollTimer);
      if (reconcileTimer) clearInterval(reconcileTimer);
      debounceTimer = pollTimer = reconcileTimer = null;
      pendingFiles.clear();
    },

    getSessions() {
      const out = [];
      for (const state of sessions.values()) {
        refreshStatus(state);
        out.push(toSummary(state));
      }
      out.sort((a, b) => (b.last_activity || '').localeCompare(a.last_activity || ''));
      return out;
    },

    getSession(id) {
      const state = sessions.get(id);
      if (!state) return null;
      refreshStatus(state);
      const summary = toSummary(state);
      summary.events = events.filter((e) => e.session_id === id).slice(-MAX_SESSION_EVENTS);
      return summary;
    },

    getEvents(limit = MAX_SESSION_EVENTS) {
      return events.slice(-limit);
    },

    /**
     * Token burn measured from these transcripts: today and the rolling last 7 LOCAL
     * days, broken down by project, agent type and session. Numbers only; no titles
     * beyond the session title already in the summary shape, and nothing from any
     * message body. Bounded output, computed on demand from per-session day buckets.
     */
    getBurn() {
      const keys = recentDayKeys(7);
      const today = keys[0];
      const week = new Set(keys);
      const byProject = new Map();
      const byAgent = new Map();
      const perSession = [];
      let todayTokens = 0;
      let weekTokens = 0;
      let todayCacheRead = 0;
      let weekCacheRead = 0;
      let busiestDay = 0;
      const dayTotals = new Map();

      for (const state of sessions.values()) {
        let sessionWeek = 0;
        for (const [key, day] of state.days) {
          if (!week.has(key)) continue;
          weekTokens += day.billable;
          weekCacheRead += day.cacheRead;
          sessionWeek += day.billable;
          dayTotals.set(key, (dayTotals.get(key) || 0) + day.billable);
          if (key === today) {
            todayTokens += day.billable;
            todayCacheRead += day.cacheRead;
          }
          const proj = projectOf(state) || 'unknown';
          byProject.set(proj, (byProject.get(proj) || 0) + day.billable);
          for (const [agentType, tokens] of day.byAgent) {
            byAgent.set(agentType, (byAgent.get(agentType) || 0) + tokens);
          }
        }
        if (sessionWeek > 0) {
          perSession.push({ session_id: state.sessionId, title: state.title, tokens: sessionWeek });
        }
      }
      for (const total of dayTotals.values()) busiestDay = Math.max(busiestDay, total);

      const top = (map, key) => Array.from(map.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([name, tokens]) => ({ [key]: name, tokens }));

      return {
        today_tokens: todayTokens,
        week_tokens: weekTokens,
        today_cache_read_tokens: todayCacheRead,
        week_cache_read_tokens: weekCacheRead,
        busiest_day_tokens: busiestDay,
        by_project: top(byProject, 'name'),
        by_agent: top(byAgent, 'agentType'),
        top_sessions: perSession.sort((a, b) => b.tokens - a.tokens).slice(0, 5),
      };
    },
  };
}
