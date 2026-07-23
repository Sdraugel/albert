// Plan label + local token burn. NO CREDENTIALS ARE READ, STORED OR SENT ANYWHERE.
//
// This module used to call claude.ai's internal usage endpoint with a stored session
// key. That path is dead and has been removed: the endpoint sits behind Cloudflare bot
// protection and answers 403 `cf-mitigated: challenge` even with a valid key, a real
// browser User-Agent and the anthropic-client-* headers. Getting past it would mean
// replaying a cf_clearance token bound to a browser's TLS fingerprint, which is both
// fragile and a bot-protection bypass. The Admin Usage & Cost API is not an
// alternative either: it is unavailable for individual accounts and reports API
// pay-as-you-go tokens, not subscription quota.
//
// So the console reports what it can measure honestly:
//   - the PLAN LABEL from the Claude Code CLI, which reads its own credentials in its
//     own process; we only ever see its parsed JSON and we keep two fields of it;
//   - LOCAL TOKEN BURN counted from the transcripts the session tailer already tails.
// Neither is the Anthropic plan percentage, and the UI says so.

import { exec, execFile } from 'node:child_process';

const CLI_TIMEOUT_MS = 5000;
const PLAN_CACHE_MS = 10 * 60 * 1000;
const MAX_OUTPUT = 64 * 1024;

let planCache = null;   // { at, value }

/* ---------------- plan label (via the Claude Code CLI) ---------------- */

// Fixed argv, no interpolation. On Windows the CLI is an npm .cmd shim, which Node
// refuses to spawn directly (its .cmd guard), so that one platform runs a constant
// command string through the shell; there is nothing user-supplied to inject.
function runAuthStatus() {
  return new Promise((resolve) => {
    const opts = { timeout: CLI_TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_OUTPUT };
    const done = (err, stdout) => resolve(err ? null : String(stdout || ''));
    try {
      if (process.platform === 'win32') exec('claude auth status --json', opts, done);
      else execFile('claude', ['auth', 'status', '--json'], opts, done);
    } catch {
      resolve(null);   // spawn refused outright (no CLI, no PATH, sandboxed)
    }
  });
}

function label(v, cap) {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  return t.length > cap ? t.slice(0, cap) : t;
}

// The CLI also returns `email` and `orgId`. Neither is read into the result: this
// dashboard gets screenshotted. The org NAME is kept only when it does not embed an
// address (the personal-plan default is literally "<email>'s Organization").
function safeOrgName(raw) {
  const name = label(raw, 48);
  if (!name || name.includes('@')) return null;
  return name;
}

/** Raw CLI stdout -> { label, orgName } or null. Pure, so it is testable offline. */
export function parsePlan(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return null;
  let json;
  try {
    json = JSON.parse(stdout.charCodeAt(0) === 0xfeff ? stdout.slice(1) : stdout);
  } catch {
    return null;   // CLI printed a banner, an error, or nothing parseable
  }
  if (!json || typeof json !== 'object' || json.loggedIn !== true) return null;
  const plan = label(json.subscriptionType, 24);
  if (!plan) return null;
  return { label: plan.toUpperCase(), orgName: safeOrgName(json.orgName) };
}

// Cached for PLAN_CACHE_MS, failures included: a box without the CLI must not spawn a
// process every minute. Never throws, never logs.
export async function getPlan(now = Date.now()) {
  if (planCache && now - planCache.at < PLAN_CACHE_MS) return planCache.value;
  let value = null;
  try {
    value = parsePlan(await runAuthStatus());
  } catch {
    value = null;
  }
  planCache = { at: now, value };
  return value;
}

export function peekPlan() {
  return planCache ? planCache.value : null;
}

/* ---------------- assembled payload ---------------- */

const EMPTY_BURN = {
  today_tokens: 0,
  week_tokens: 0,
  today_cache_read_tokens: 0,
  week_cache_read_tokens: 0,
  busiest_day_tokens: 0,
  by_project: [],
  by_agent: [],
  top_sessions: [],
};

function nonNeg(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function rows(list, key, cap) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const row of list.slice(0, cap)) {
    if (!row || typeof row !== 'object') continue;
    const name = label(row[key], 40);
    if (!name) continue;
    out.push({ [key]: name, tokens: nonNeg(row.tokens) });
  }
  return out;
}

// Field-by-field rebuild of whatever the tailer handed over, so the wire shape stays
// fixed even if the tailer grows fields later.
export function normalizeBurn(burn) {
  if (!burn || typeof burn !== 'object') return { ...EMPTY_BURN };
  return {
    today_tokens: nonNeg(burn.today_tokens),
    week_tokens: nonNeg(burn.week_tokens),
    today_cache_read_tokens: nonNeg(burn.today_cache_read_tokens),
    week_cache_read_tokens: nonNeg(burn.week_cache_read_tokens),
    busiest_day_tokens: nonNeg(burn.busiest_day_tokens),
    by_project: rows(burn.by_project, 'name', 6),
    by_agent: rows(burn.by_agent, 'agentType', 6),
    top_sessions: Array.isArray(burn.top_sessions)
      ? burn.top_sessions.slice(0, 5).map((s) => ({
        session_id: label(s && s.session_id, 64),
        title: label(s && s.title, 80),
        tokens: nonNeg(s && s.tokens),
      })).filter((s) => s.session_id)
      : [],
  };
}

/** The /api/usage payload. `burn` comes from the tailer; the plan may shell out. */
export async function buildUsage(burn) {
  return {
    plan: await getPlan(),
    burn: normalizeBurn(burn),
    generated_at: new Date().toISOString(),
  };
}

/** Same payload from cached parts only: no process spawn, safe on the SSE hot path. */
export function snapshotUsage(burn) {
  return {
    plan: peekPlan(),
    burn: normalizeBurn(burn),
    generated_at: new Date().toISOString(),
  };
}
