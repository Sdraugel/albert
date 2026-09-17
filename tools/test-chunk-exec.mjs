#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

const SRC = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'harness', 'workflows', 'chunk-exec.js'));
const WALL_MS = 5000;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function loadScript() {
  const lines = readFileSync(SRC, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('export const meta'));
  const end = lines.findIndex((l, i) => i > start && /^\}\s*;?\s*$/.test(l));
  if (start < 0 || end < 0) throw new Error(`meta block not found in ${SRC}`);
  const body = [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n')
    .replace(/^const MINUTES = 60 \* 1000;/m, 'const MINUTES = 1;');
  return new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'setTimeout', 'clearTimeout', body);
}

const head = (label) => label.split(/[:@]/)[0];
const lookup = (table, label) => (label in table ? table[label] : table[head(label)]);

function runtime({ results, delays, hang }) {
  const calls = [], logs = [], phases = [], seen = new Map();
  async function agent(prompt, opts = {}) {
    const label = opts.label || '(unlabeled)';
    const rec = { label, agentType: opts.agentType, model: opts.model, effort: opts.effort, prompt, startedAt: performance.now(), endedAt: undefined };
    calls.push(rec);
    if (hang.includes(label) || hang.includes(head(label))) return new Promise(() => {});
    const nth = seen.get(label) || 0;
    seen.set(label, nth + 1);
    const delay = lookup(delays, label);
    if (delay) await sleep(delay);
    let r = lookup(results, label);
    if (typeof r === 'function') r = r(nth, prompt, opts);
    else if (Array.isArray(r)) r = r[Math.min(nth, r.length - 1)];
    rec.endedAt = performance.now();
    return r && typeof r === 'object' ? structuredClone(r) : r;
  }
  const parallel = (thunks) => Promise.all(thunks.map((f) => Promise.resolve().then(f).catch(() => null)));
  const pipeline = (items, ...stages) => Promise.all(items.map(async (item, i) => {
    let prev = item;
    try { for (const s of stages) prev = await s(prev, item, i); return prev; } catch { return null; }
  }));
  return {
    agent, parallel, pipeline, calls, logs, phases,
    phase: (t) => phases.push(t), log: (m) => logs.push(m),
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
  };
}

const DEFAULTS = {
  produce: { passed: true, commit: 'abc', evidence: ['p.png'] },
  verify: { passed: true, evidence: ['v.png'] },
  gate: { pass: true }, qa: { pass: true }, skeptic: { pass: true }, deps: { pass: true },
  merge: (nth, prompt) => ({ merged: [...new Set(prompt.match(/harness\/r-c1--[\w-]+/g) || [])], conflicts: [] }),
  cleanup: 'ok',
};
const task = (id, o = {}) => ({ id, role: 'worker', model: 'sonnet', description: `do ${id}`, depends_on: [], verify_commands: ['npm test'], gates: ['code-reviewer'], expect: 'exit 0', kind: 'dev', ...o });

async function execute(script, cfg) {
  const tasks = cfg.tasks;
  const plan = { git_root: 'C:/x', chunk_branch: 'harness/r-c1', base_branch: 'main', profile: 'dev', merge_policy: 'auto_on_signoff', allow_deploy: false, tasks, ...cfg.plan };
  const worktrees = { worktrees: tasks.map((t) => ({ task_id: t.id, path: `C:/wt/${t.id}`, branch: `harness/r-c1--${t.id}` })) };
  const rt = runtime({ results: { ...DEFAULTS, load: plan, worktrees, ...cfg.results }, delays: cfg.delays || {}, hang: cfg.hang || [] });
  const out = { calls: rt.calls, logs: rt.logs, phases: rt.phases, value: undefined, error: undefined, elapsed: 0 };
  const t0 = performance.now();
  let timer;
  const guard = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`script still running after ${WALL_MS} ms`)), WALL_MS); });
  const p = script({ run_id: 'r', chunk: 'c1' }, rt.agent, rt.parallel, rt.pipeline, rt.phase, rt.log, rt.budget, setTimeout, clearTimeout);
  p.catch(() => {});
  try { out.value = await Promise.race([p, guard]); } catch (e) { out.error = e; } finally { clearTimeout(timer); }
  out.elapsed = performance.now() - t0;
  return out;
}

const first = (o, l) => o.calls.find((c) => c.label === l);
const all = (o, prefix) => o.calls.filter((c) => c.label.startsWith(prefix));
const res = (o, id) => (o.value?.results || []).find((r) => r.task_id === id) || {};
const light = { tasks: [task('T1')], delays: { verify: 5, gate: 5 } };
const design = (o = {}) => task('T1', { role: 'designer', kind: 'design', gates: [], verify_commands: [], ...o });

const SCENARIOS = [
  ['A light dev, auto_on_signoff: gate overlaps verify, no QA, effort unset', light, (o, ok) => {
    const v = first(o, 'verify:T1'), g = first(o, 'gate:T1:code-reviewer');
    ok(res(o, 'T1').passed === true, 'T1 passed=true');
    ok(v && g, 'verify:T1 and gate:T1:code-reviewer both called');
    ok(v && g && g.startedAt < v.endedAt, 'gate:T1:code-reviewer starts before verify:T1 ends (overlap)');
    ok(!first(o, 'qa:T1'), 'no qa:T1 call');
    ok(v?.effort === undefined && g?.effort === undefined, `verify/gate effort undefined (got ${v?.effort}/${g?.effort})`);
  }],
  ['B light dev, merge_policy none: QA runs after verify and gates', { ...light, plan: { merge_policy: 'none' } }, (o, ok) => {
    const v = first(o, 'verify:T1'), g = first(o, 'gate:T1:code-reviewer'), q = first(o, 'qa:T1');
    ok(res(o, 'T1').passed === true, 'T1 passed=true');
    ok(q, 'qa:T1 called');
    ok(q && v && g && q.startedAt >= v.endedAt && q.startedAt >= g.endedAt, 'qa:T1 starts after verify and gate end');
  }],
  ['C heavy opus: verify before gates, QA after gates, effort high', { ...light, tasks: [task('T1', { model: 'opus' })] }, (o, ok) => {
    const v = first(o, 'verify:T1'), g = first(o, 'gate:T1:code-reviewer'), q = first(o, 'qa:T1');
    ok(res(o, 'T1').passed === true, 'T1 passed=true');
    ok(v && g && v.endedAt <= g.startedAt, 'verify:T1 ends before gate:T1:code-reviewer starts');
    ok(q && g && q.startedAt >= g.endedAt, 'qa:T1 starts after gate ends');
    ok([v, g, q].every((c) => c?.effort === 'high'), 'verify/gate/qa effort high');
  }],
  ['D light, verify fails at sonnet then passes at opus: one escalation', { tasks: [task('T1')], results: { 'verify:T1': [{ passed: false, blocker: 'nope' }, { passed: true, evidence: ['v.png'] }] } }, (o, ok) => {
    const produced = all(o, 'produce:').map((c) => c.label).join(' ');
    ok(produced === 'produce:T1@sonnet produce:T1@opus', `produce sonnet then opus (got "${produced}")`);
    ok(all(o, 'gate:T1:code-reviewer').length === 2, `gate called once per attempt (got ${all(o, 'gate:T1:code-reviewer').length})`);
    ok(res(o, 'T1').passed === true, 'T1 passed=true');
    ok(res(o, 'T1').model_used === 'opus', `model_used opus (got ${res(o, 'T1').model_used})`);
  }],
  ['E verify:T1 hangs: run finishes, T1 fails with "timed out"', { tasks: [task('T1')], hang: ['verify:T1'] }, (o, ok) => {
    ok(res(o, 'T1').passed === false, 'T1 passed=false');
    ok(/timed out/i.test(res(o, 'T1').blocker || ''), `blocker mentions "timed out" (got ${JSON.stringify(res(o, 'T1').blocker)})`);
  }],
  ['F gate:T1:code-reviewer hangs (light): run finishes, T1 fails', { tasks: [task('T1')], hang: ['gate:T1:code-reviewer'] }, (o, ok) => {
    ok(res(o, 'T1').passed === false, 'T1 passed=false');
    ok(/gates|timed out/i.test(res(o, 'T1').blocker || ''), `blocker mentions gates or timed out (got ${JSON.stringify(res(o, 'T1').blocker)})`);
  }],
  ['G design light: design-review gate reuses producer screenshots', { tasks: [design()] }, (o, ok) => {
    const g = first(o, 'gate:T1:design-review'), v = first(o, 'verify:T1');
    ok(g && g.agentType === 'loop-designer', 'gate:T1:design-review called with agentType loop-designer');
    ok(g && !g.prompt.includes('render the affected page'), 'design-review prompt does not say "render the affected page"');
    ok(g && g.prompt.includes('p.png'), 'design-review prompt references producer evidence p.png');
    ok(v && v.prompt.includes('Re-take'), 'verify prompt still says "Re-take"');
  }],
  ['H design heavy opus: design-review gate renders the page itself', { tasks: [design({ model: 'opus' })] }, (o, ok) => {
    const g = first(o, 'gate:T1:design-review');
    ok(g && g.agentType === 'loop-designer', 'gate:T1:design-review called with agentType loop-designer');
    ok(g && g.prompt.includes('render the affected page'), 'design-review prompt says "render the affected page"');
  }],
  ['I T2 depends on T1, T1 fails verify at both tiers', { tasks: [task('T1'), task('T2', { depends_on: ['T1'] })], results: { 'verify:T1': { passed: false, blocker: 'bad' } } }, (o, ok) => {
    ok(res(o, 'T1').passed === false, 'T1 passed=false');
    ok(res(o, 'T2').blocker === 'in-chunk dependency failed', `T2 blocker "in-chunk dependency failed" (got ${JSON.stringify(res(o, 'T2').blocker)})`);
    ok(all(o, 'produce:T2').length === 0, 'no produce:T2 call');
  }],
  ['J research profile: skeptic only, no gates or QA', { tasks: [task('T1', { role: 'researcher', kind: 'research', gates: [] })], plan: { profile: 'research' } }, (o, ok) => {
    ok(first(o, 'skeptic:T1'), 'skeptic:T1 called');
    ok(all(o, 'gate:').length === 0 && all(o, 'qa:').length === 0, 'no gate or qa calls');
    ok(res(o, 'T1').passed === true, 'T1 passed=true');
  }],
];

function commonChecks(name, o, fail) {
  if (o.error) return fail(`${name}: run did not finish (${o.error.message})`);
  const last = o.calls.at(-1)?.label, idx = (l) => o.calls.findIndex((c) => c.label === l);
  if (o.calls[0]?.label !== 'load') fail(`${name}: load is not the first call`);
  if (o.calls[1]?.label !== 'worktrees') fail(`${name}: worktrees is not the second call`);
  if (last !== 'cleanup') fail(`${name}: cleanup is not the last call (got ${last})`);
  if ((o.value?.results || []).some((r) => r.passed) && !(idx('merge') >= 0 && idx('merge') < idx('cleanup'))) fail(`${name}: merge missing or not before cleanup`);
  for (const k of ['chunk', 'results', 'role_warnings']) if (!(o.value && k in o.value)) fail(`${name}: return value lacks "${k}"`);
}

const script = loadScript();
const rows = [], kFails = [];
const started = performance.now();
for (const [name, cfg, check] of SCENARIOS) {
  const o = await execute(script, cfg);
  const fails = [];
  const ok = (cond, msg) => { if (!cond) fails.push(msg); };
  if (o.error) fails.push(`run did not finish cleanly: ${o.error.message}`);
  try { check(o, ok); } catch (e) { fails.push(`assertion threw: ${e.message}`); }
  commonChecks(name[0], o, (m) => kFails.push(m));
  rows.push({ name, fails });
}
rows.push({ name: 'K every scenario: load, worktrees, merge before cleanup, cleanup last, return shape', fails: kFails });

const width = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) {
  console.log(`${r.name.padEnd(width)}  ${r.fails.length ? 'FAIL' : 'PASS'}`);
  for (const f of r.fails) console.log(`${' '.repeat(width + 4)}- ${f}`);
}
const failed = rows.filter((r) => r.fails.length).length;
console.log(`\n${rows.length - failed}/${rows.length} scenarios passed in ${Math.round(performance.now() - started)} ms against ${SRC}`);
process.exitCode = failed ? 1 : 0;
