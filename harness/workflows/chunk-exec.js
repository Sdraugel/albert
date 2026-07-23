export const meta = {
  name: 'chunk-exec',
  description: 'Run one /albert chunk in parallel: worktree-isolated producers on per-task model tiers, pipelined verify + gates + QA, dependency-ordered merge into the chunk branch',
  whenToUse: 'Invoked by the Albert controller (A.L.B.E.R.T.) once per chunk. args: {run_id, chunk}',
  phases: [
    { title: 'Load', detail: 'read tasks.json for the chunk' },
    { title: 'Worktrees', detail: 'create one git worktree per task (serial)' },
    { title: 'Execute', detail: 'produce+verify (escalate) then gates+QA, per task, concurrent' },
    { title: 'Merge', detail: 'merge passed task branches into the chunk branch in dep order' },
    { title: 'Cleanup', detail: 'always prune worktrees and task branches' },
  ],
}

// Workflow scripts have NO filesystem or shell access, so every disk/git action is done by an
// agent. This body is pure orchestration plus the dependency-DAG scheduling (plain JS, allowed).

const STORE = '{{CLAUDE_DIR}}\\agent-runs';
const EMIT = '{{CLAUDE_DIR}}\\agent-runs\\_emit.mjs';
// The Workflow tool may hand `args` through as a JSON string rather than a parsed
// object, so accept either form instead of failing arg validation on the string.
const ARGS = typeof args === 'string' ? JSON.parse(args) : args;
const RUN = ARGS && ARGS.run_id;
const CHUNK = ARGS && ARGS.chunk;
if (!RUN || !CHUNK) throw new Error('chunk-exec requires args {run_id, chunk}');

const RUN_DIR = STORE + '\\' + RUN;
const TIERS = ['haiku', 'sonnet', 'opus'];
const ROLE_AGENT = {
  worker: 'loop-worker', 'data-scientist': 'loop-data-scientist', designer: 'loop-designer',
  researcher: 'loop-researcher', devops: 'loop-devops',
};
const GATE_AGENTS = ['code-reviewer', 'security-reviewer', 'performance-reviewer'];

// A telemetry line an agent runs so the console graph lights this agent up while it works.
// Summary is sanitized (no quotes/newlines) so it can never break the generated shell line.
function emit(type, actor, target, summary, taskId) {
  const s = String(summary || '').replace(/["\r\n]/g, ' ').slice(0, 80);
  return `node "${EMIT}" ${RUN} ${type} ${actor} ${target} "${s}" --chunk ${CHUNK}` +
    (taskId ? ` --task ${taskId}` : '');
}

const LOAD_SCHEMA = {
  type: 'object', required: ['git_root', 'chunk_branch', 'base_branch', 'tasks'],
  properties: {
    git_root: { type: 'string' }, project_path: { type: 'string' },
    chunk_branch: { type: 'string' }, base_branch: { type: 'string' },
    allow_deploy: { type: 'boolean' }, profile: { type: 'string' },
    tasks: {
      type: 'array', items: {
        type: 'object', required: ['id', 'role', 'model', 'description'],
        properties: {
          id: { type: 'string' }, role: { type: 'string' }, model: { enum: TIERS },
          description: { type: 'string' }, depends_on: { type: 'array', items: { type: 'string' } },
          verify_commands: { type: 'array', items: { type: 'string' } },
          gates: { type: 'array', items: { type: 'string' } },
          expect: { type: 'string' }, kind: { type: 'string' },
        },
      },
    },
  },
};

phase('Load')
const plan = (await agent(
  `Read the /albert run store and return the chunk's tasks as structured JSON. Do NOT implement anything.
Run dir: ${RUN_DIR}
1. Read ${RUN_DIR}\\tasks.json (strip a leading BOM before JSON.parse), ${RUN_DIR}\\project.json, ${RUN_DIR}\\goal.md.
2. Return only the tasks whose "chunk" === "${CHUNK}" and whose status is not already "done".
   For each: id; role; model (default "sonnet" if absent); description (from "description" or "title");
   depends_on (array, default []); verify_commands (from verify.commands, default []); gates (from
   verify.gates, default []); expect (from verify.expect); kind (from verify.kind, e.g. "dev" or "research").
3. git_root and project_path from project.json. base_branch from tasks.json/goal.md. profile from goal.md/tasks.json.
   chunk_branch = "harness/${RUN}-${CHUNK}". allow_deploy from goal.md (default false).
Return the LOAD schema object exactly.`,
  { label: 'load', phase: 'Load', schema: LOAD_SCHEMA, effort: 'low' }
)) || {};

const tasks = (plan.tasks || []).filter(Boolean);
if (!tasks.length) { log(`chunk ${CHUNK}: nothing to do`); return { chunk: CHUNK, results: [] }; }
const byId = new Map(tasks.map((t) => [t.id, t]));
const GIT = plan.git_root, CHUNK_BRANCH = plan.chunk_branch, BASE = plan.base_branch;
const IS_RESEARCH = tasks.some((t) => t.kind === 'research') || plan.profile === 'research';
// Task branch is a SIBLING of the chunk branch (the "--" keeps it in the same path segment) so it
// never nests under the chunk branch ref, which would be a git file/directory conflict.
const taskBranch = (id) => `${CHUNK_BRANCH}--${id}`;

phase('Worktrees')
// Serial creation avoids the .git/worktrees lock race that concurrent `git worktree add` hits.
const WT_SCHEMA = {
  type: 'object', required: ['worktrees'], properties: {
    worktrees: { type: 'array', items: { type: 'object', required: ['task_id', 'path', 'branch'],
      properties: { task_id: { type: 'string' }, path: { type: 'string' }, branch: { type: 'string' } } } },
  },
};
const wtPlan = (await agent(
  `Create one git worktree per task, SERIALLY (never run two 'git worktree add' at once). Repo git root: ${GIT}.
First ensure the chunk branch exists: from ${GIT}, if branch "${CHUNK_BRANCH}" is missing,
  git branch "${CHUNK_BRANCH}" "${BASE}"  (create the ref without checking it out).
Then for each task id below, create a worktree on a NEW SIBLING branch off "${CHUNK_BRANCH}":
  git -C "${GIT}" worktree add "<repo_parent>\\.hx-wt\\${RUN}-${CHUNK}-<id>" -b "${CHUNK_BRANCH}--<id>" "${CHUNK_BRANCH}"
where <repo_parent> is the folder CONTAINING the repo, so ".hx-wt" is a sibling of the repo and never nests inside it.
If a branch "${CHUNK_BRANCH}--<id>" already exists from a prior run, delete it first (git branch -D) then re-add.
Task ids: ${tasks.map((t) => t.id).join(', ')}.
Return {worktrees:[{task_id, path, branch}]}. If an add fails, set that task's path to "ERROR: <reason>".`,
  { label: 'worktrees', phase: 'Worktrees', schema: WT_SCHEMA, effort: 'low' }
)) || { worktrees: [] };
const wt = new Map((wtPlan.worktrees || []).map((w) => [w.task_id, w]));

phase('Execute')
const VERDICT = {
  type: 'object', required: ['passed'], properties: {
    passed: { type: 'boolean' }, model_used: { type: 'string' }, blocker: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } }, commit: { type: 'string' },
  },
};
const GATE = { type: 'object', required: ['pass'], properties: { pass: { type: 'boolean' }, notes: { type: 'string' } } };

function producePrompt(t, w, model) {
  return `You are the ${t.role} producer for task ${t.id}, working ONLY inside your git worktree ${w.path} (cd there first; never touch the repo's main worktree). Model tier: ${model}.
Task: ${t.description}
Implement it, then run its verify commands as your own check: ${(t.verify_commands || []).join(' && ') || '(none given)'}.
Expect: ${t.expect || 'commands exit 0'}. Commit your work on branch ${w.branch} inside this worktree.
${t.role === 'devops' && !plan.allow_deploy ? 'DEPLOY GUARDRAIL: allow_deploy is false. Stage only, do NOT deploy/migrate/rotate. Return blocker "awaiting-deploy-approval".' : ''}
Telemetry: at start run: ${emit('producer.dispatched', 'controller', ROLE_AGENT[t.role] || 'loop-worker', t.id + ': ' + t.description, t.id)}
Return {passed, commit, blocker, evidence}.`;
}
function verifyPrompt(t, w) {
  return `Independently verify task ${t.id} from a CLEAN state inside worktree ${w.path} (cd there). Trust only your own exit codes.
Re-run: ${(t.verify_commands || []).join(' && ') || '(none)'}. Expect: ${t.expect || 'exit 0'}.
Telemetry: at end run: ${emit('verify.result', 'loop-verifier-dev', 'controller', t.id + ' verify', t.id)}
Return {passed, blocker, evidence}.`;
}

// Give a dependent task its prerequisites' code before it produces, so same-chunk deps that share a
// file are not written blind. Only runs when there are passed in-chunk dep branches.
async function mergeDepsIntoWorktree(t, w, depBranches) {
  if (!depBranches.length) return true;
  const r = await agent(
    `Inside git worktree ${w.path} (cd there), merge these dependency branches so this task builds on their work, one at a time: ${depBranches.join(', ')}. For each: git merge --no-edit <branch>; resolve any conflict keeping both intents, commit. Return {pass, notes}.`,
    { label: `deps:${t.id}`, phase: 'Execute', schema: GATE, agentType: 'loop-worker', effort: 'low' });
  return !!(r && r.pass);
}

// produce+verify with ONE escalation up the model tier ladder on a verify failure.
async function produceAndVerify(t, w) {
  const start = Math.max(0, TIERS.indexOf(t.model || 'sonnet'));
  for (let step = 0; step < 2; step++) {
    const model = TIERS[Math.min(start + step, TIERS.length - 1)];
    const prod = await agent(producePrompt(t, w, model),
      { label: `produce:${t.id}@${model}`, phase: 'Execute', schema: VERDICT, agentType: ROLE_AGENT[t.role] || 'loop-worker', model });
    if (prod && prod.blocker === 'awaiting-deploy-approval') return { passed: false, model_used: model, blocker: prod.blocker };
    const ver = await agent(verifyPrompt(t, w),
      { label: `verify:${t.id}`, phase: 'Execute', schema: VERDICT, agentType: 'loop-verifier-dev', effort: 'high' });
    if (ver && ver.passed) return { passed: true, model_used: model, evidence: (ver.evidence || []).concat((prod && prod.evidence) || []), commit: prod && prod.commit };
    if (start + step + 1 >= TIERS.length) return { passed: false, model_used: model, blocker: (ver && ver.blocker) || 'verify failed at top tier' };
    // else: escalate one tier and retry once
  }
  return { passed: false, model_used: TIERS[Math.min(start + 1, TIERS.length - 1)], blocker: 'verify failed' };
}

// Gates + QA (dev) or the skeptic (research). A dead (null) critic counts as a FAIL, never a pass.
async function signoff(t, w) {
  if (IS_RESEARCH) {
    const sk = await agent(
      `Try to REFUTE task ${t.id}'s claimed result in worktree ${w.path}; reject-if-uncertain. Telemetry at end: ${emit('skeptic.result', 'loop-skeptic-research', 'controller', t.id + ' skeptic', t.id)}. Return {pass:true only if you CANNOT refute, notes}.`,
      { label: `skeptic:${t.id}`, phase: 'Execute', schema: GATE, agentType: 'loop-skeptic-research', effort: 'high' });
    return !!(sk && sk.pass);
  }
  const gates = (t.gates || []).filter((g) => GATE_AGENTS.includes(g));
  const gateResults = await parallel(gates.map((g) => () =>
    agent(`Review task ${t.id}'s diff in worktree ${w.path} as ${g}. Telemetry at end: ${emit('gate.result', g, 'controller', t.id + ' ' + g, t.id)}. Return {pass, notes}.`,
      { label: `gate:${t.id}:${g}`, phase: 'Execute', schema: GATE, agentType: g, effort: 'high' })));
  const gatesPass = gateResults.length === gates.length && gateResults.every((r) => r && r.pass);
  const qa = await agent(
    `QA task ${t.id} in worktree ${w.path}: exercise real user journeys and edge cases beyond its narrow verify. Telemetry at end: ${emit('qa.result', 'loop-qa', 'controller', t.id + ' qa', t.id)}. Return {pass, notes}.`,
    { label: `qa:${t.id}`, phase: 'Execute', schema: GATE, agentType: 'loop-qa', effort: 'high' });
  return gatesPass && !!(qa && qa.pass);
}

// Dependency-DAG scheduling. `state`: 'visiting' guards cycles; independent tasks run concurrently
// (the runtime caps real concurrency). Returns each task's final verdict.
const running = new Map();
const state = new Map();
function runTask(t) {
  if (running.has(t.id)) return running.get(t.id);
  if (state.get(t.id) === 'visiting') return Promise.resolve({ task_id: t.id, passed: false, blocker: 'dependency cycle', branch: taskBranch(t.id), merged: false });
  state.set(t.id, 'visiting');
  const p = (async () => {
    const deps = (t.depends_on || []).filter((d) => byId.has(d)).map((d) => byId.get(d));
    const depResults = await Promise.all(deps.map(runTask));
    if (depResults.some((r) => !r || !r.passed)) return { task_id: t.id, passed: false, blocker: 'in-chunk dependency failed', branch: taskBranch(t.id), merged: false };
    const w = wt.get(t.id);
    if (!w || String(w.path).startsWith('ERROR')) return { task_id: t.id, passed: false, blocker: 'no worktree', branch: taskBranch(t.id), merged: false };
    const okDeps = await mergeDepsIntoWorktree(t, w, depResults.map((r) => r.branch).filter(Boolean));
    if (!okDeps) return { task_id: t.id, passed: false, blocker: 'could not merge deps into worktree', branch: w.branch, merged: false };
    const pv = await produceAndVerify(t, w);
    if (!pv.passed) return { task_id: t.id, passed: false, model_used: pv.model_used, blocker: pv.blocker, branch: w.branch, merged: false, evidence: pv.evidence };
    const signed = await signoff(t, w);
    return { task_id: t.id, passed: signed, model_used: pv.model_used, blocker: signed ? null : 'gates/QA withheld sign-off', branch: w.branch, merged: false, evidence: pv.evidence };
  })();
  running.set(t.id, p);
  p.then(() => state.set(t.id, 'done'));
  return p;
}
const results = await Promise.all(tasks.map(runTask));

phase('Merge')
const order = topoOrder(tasks);
const toMerge = order
  .map((id) => results.find((x) => x.task_id === id))
  .filter((r) => r && r.passed && r.branch)
  .map((r) => r.branch);
let merged = { merged: [], conflicts: [] };
if (toMerge.length) {
  const MERGE_SCHEMA = { type: 'object', required: ['merged'], properties: {
    merged: { type: 'array', items: { type: 'string' } }, conflicts: { type: 'array', items: { type: 'string' } } } };
  merged = (await agent(
    `Merge these task branches into "${CHUNK_BRANCH}" in ${GIT}, ONE AT A TIME in this exact order (never in parallel): ${toMerge.join(', ')}.
For each: git -C "${GIT}" checkout "${CHUNK_BRANCH}"; git -C "${GIT}" merge --no-ff --no-edit <branch>. On a conflict, resolve it against the updated chunk branch (keep both tasks' intent), commit, continue. Telemetry per merge: ${emit('merge', 'controller', CHUNK_BRANCH, 'merged a task branch', '')}.
Return {merged:[branch...], conflicts:[branch that needed manual help...]}.`,
    { label: 'merge', phase: 'Merge', schema: MERGE_SCHEMA, agentType: 'loop-worker', effort: 'high' })) || { merged: [], conflicts: [] };
}
const mergedSet = new Set(merged.merged || []);
for (const r of results) r.merged = !!(r.branch && mergedSet.has(r.branch));

phase('Cleanup')
// Always runs (even if nothing merged), so leftover worktrees and task branches never break a retry.
await agent(
  `Clean up this chunk's scratch git state in ${GIT}. 1) Remove every worktree whose path contains ".hx-wt\\${RUN}-${CHUNK}-": from 'git -C "${GIT}" worktree list', for each match run git -C "${GIT}" worktree remove --force <path>; then git -C "${GIT}" worktree prune. 2) Delete every task branch matching "${CHUNK_BRANCH}--*": git -C "${GIT}" branch -D <branch> (they are either merged into ${CHUNK_BRANCH} already or are discarded failed attempts). Do NOT delete "${CHUNK_BRANCH}" itself. Return a one-line summary.`,
  { label: 'cleanup', phase: 'Cleanup', effort: 'low' });

log(`chunk ${CHUNK}: ${results.filter((r) => r.passed).length}/${results.length} passed, ${(merged.merged || []).length} merged`);
return { chunk: CHUNK, results };

// --- helpers ---
function topoOrder(list) {
  const seen = new Set(), out = [], id2 = new Map(list.map((t) => [t.id, t]));
  function visit(t, stack) {
    if (!t || seen.has(t.id) || stack.has(t.id)) return; // stack guard drops back-edges on a cycle
    stack.add(t.id);
    for (const d of (t.depends_on || [])) if (id2.has(d)) visit(id2.get(d), stack);
    stack.delete(t.id);
    seen.add(t.id);
    out.push(t.id);
  }
  for (const t of list) visit(t, new Set());
  return out;
}
