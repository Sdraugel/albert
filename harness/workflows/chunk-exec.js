export const meta = {
  name: 'chunk-exec',
  description: 'Run one /albert chunk in parallel: worktree-isolated producers on per-task model tiers, pipelined verify + gates + QA, dependency-ordered merge into the chunk branch',
  whenToUse: 'Invoked by the Albert controller (A.L.B.E.R.T.) once per chunk. args: {run_id, chunk}',
  phases: [
    { title: 'Load', detail: 'read tasks.json for the chunk' },
    { title: 'Worktrees', detail: 'create one git worktree per task (serial)' },
    { title: 'Execute', detail: 'produce, then verify (light tasks: gates alongside), then sign-off, per task, concurrent, every agent under a deadline' },
    { title: 'Merge', detail: 'merge passed task branches into the chunk branch in dep order' },
    { title: 'Cleanup', detail: 'always prune worktrees and task branches' },
  ],
}

// Workflow scripts have NO filesystem or shell access, so every disk/git action is done by an
// agent. This body is pure orchestration plus the dependency-DAG scheduling (plain JS, allowed).

const STORE = '{{CLAUDE_DIR}}/agent-runs';
const EMIT = '{{CLAUDE_DIR}}/agent-runs/_emit.mjs';
// The Workflow tool may hand `args` through as a JSON string rather than a parsed
// object, so accept either form instead of failing arg validation on the string.
const ARGS = typeof args === 'string' ? JSON.parse(args) : args;
const RUN = ARGS && ARGS.run_id;
const CHUNK = ARGS && ARGS.chunk;
if (!RUN || !CHUNK) throw new Error('chunk-exec requires args {run_id, chunk}');

const RUN_DIR = STORE + '/' + RUN;
const TIERS = ['haiku', 'sonnet', 'opus'];
const ROLE_AGENT = {
  worker: 'loop-worker', 'data-scientist': 'loop-data-scientist', designer: 'loop-designer',
  researcher: 'loop-researcher', devops: 'loop-devops',
};
// Common ways a planner writes a role that are not the canonical bare noun. Measured on the
// real store: 35 of 74 tasks carried the AGENT name ("loop-worker") instead of the role
// ("worker"). For worker the two collapsed to the same target by luck, so the mismatch was
// invisible; for any other role it silently routed the task to the generic worker and the
// specialist never ran.
const ROLE_ALIAS = {
  design: 'designer', ui: 'designer', ux: 'designer', frontend: 'designer', 'front-end': 'designer',
  'data-science': 'data-scientist', datascientist: 'data-scientist', ds: 'data-scientist',
  research: 'researcher', infra: 'devops', ops: 'devops', deploy: 'devops',
  dev: 'worker', engineer: 'worker', code: 'worker',
};

// Resolve a task's role to a producer agent. Tolerant of case, whitespace, underscores and a
// leading "loop-", but NEVER silently wrong: unknown roles are reported by roleWarnings below.
function normalizeRole(role) {
  const raw = String(role == null ? '' : role).trim().toLowerCase().replace(/_/g, '-');
  const bare = raw.replace(/^loop-/, '');
  return ROLE_ALIAS[bare] || bare;
}
const roleWarnings = [];
function agentFor(t) {
  const canonical = normalizeRole(t && t.role);
  const mapped = ROLE_AGENT[canonical];
  if (!mapped) {
    roleWarnings.push({ task_id: (t && t.id) || '?', role: (t && t.role) || '(missing)', fell_back_to: 'loop-worker' });
    return 'loop-worker';
  }
  return mapped;
}
function isDesign(t) {
  return normalizeRole(t && t.role) === 'designer' || (t && t.kind === 'design');
}

const GATE_AGENTS = ['code-reviewer', 'security-reviewer', 'performance-reviewer'];
// A design task's sign-off needs someone who can look at the rendered page. Requested gates
// that match no agent used to be dropped silently (see signoff), which is how a task asking
// for "design-system-untouched" shipped with no design review at all.
const GATE_ALIAS = {
  'design-system-untouched': 'loop-designer', design: 'loop-designer', 'design-review': 'loop-designer',
  a11y: 'loop-designer', accessibility: 'loop-designer',
  security: 'security-reviewer', performance: 'performance-reviewer', perf: 'performance-reviewer',
  'code-review': 'code-reviewer', review: 'code-reviewer',
};

// Nothing in the runtime bounds an agent: one QA critic sat 8 hours on a shell call that never
// returned and the whole chunk waited with it. Every agent below is raced against a ceiling
// per kind (minutes; the second column is for design tasks, which render pages and take
// screenshots). The losing agent is not cancelled, there is no API for that; it just stops
// mattering. A timed-out step is a FAIL, never a pass.
const MINUTES = 60 * 1000;
const TIMEOUT = {
  load: [5, 5], worktrees: [10, 10], deps: [10, 10],
  produce: [60, 90], verify: [30, 60], gate: [20, 40], qa: [30, 45], skeptic: [45, 45],
  merge: [20, 20], cleanup: [10, 10],
};
const TIMED_OUT = Symbol('timed out');
async function timedAgent(kind, design, fallback, prompt, opts) {
  const minutes = TIMEOUT[kind][design ? 1 : 0];
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), minutes * MINUTES); });
  let r;
  try {
    r = await Promise.race([agent(prompt, opts), deadline]);
  } finally {
    clearTimeout(timer);
  }
  if (r !== TIMED_OUT) return r;
  log(`${opts.label}: no result after ${minutes} min, counted as FAIL`);
  return typeof fallback === 'function' ? fallback(`timed out after ${minutes} min`) : fallback;
}
const verdictTimeout = (why) => ({ passed: false, blocker: why });
const gateTimeout = (why) => ({ pass: false, notes: why });

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
    allow_deploy: { type: 'boolean' }, profile: { type: 'string' }, merge_policy: { type: 'string' },
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
const plan = await timedAgent('load', false, () => { throw new Error('chunk-exec: loading the run store timed out'); },
  `Read the /albert run store and return the chunk's tasks as structured JSON. Do NOT implement anything.
Run dir: ${RUN_DIR}
1. Read ${RUN_DIR}/tasks.json (strip a leading BOM before JSON.parse), ${RUN_DIR}/project.json, ${RUN_DIR}/goal.md.
2. Return only the tasks whose "chunk" === "${CHUNK}" and whose status is not already "done".
   For each: id; role (copy VERBATIM, do not normalize or "correct" it); model (default "sonnet" if
   absent); description (from "description" or "title");
   depends_on (array, default []); verify_commands (from verify.commands, default []); gates (from
   verify.gates, default []); expect (from verify.expect); kind (from verify.kind, one of "dev",
   "research" or "design"; pass "design" through unchanged, and if verify has a route/viewports but
   no commands, treat kind as "design").
3. git_root and project_path from project.json. base_branch from tasks.json/goal.md. profile from goal.md/tasks.json.
   merge_policy from goal.md (default "auto_on_signoff"). chunk_branch = "harness/${RUN}-${CHUNK}".
   allow_deploy from goal.md (default false).
Return the LOAD schema object exactly.`,
  { label: 'load', phase: 'Load', schema: LOAD_SCHEMA, effort: 'low' }) || {};

const tasks = (plan.tasks || []).filter(Boolean);
if (!tasks.length) { log(`chunk ${CHUNK}: nothing to do`); return { chunk: CHUNK, results: [] }; }
const byId = new Map(tasks.map((t) => [t.id, t]));
const GIT = plan.git_root, CHUNK_BRANCH = plan.chunk_branch, BASE = plan.base_branch;
const IS_RESEARCH = tasks.some((t) => t.kind === 'research') || plan.profile === 'research';
// Under auto_on_signoff the controller runs loop-qa on the merged chunk branch before the PR
// merges (SKILL.md LOOP step 7), so a light task's own QA pass would walk the same journeys
// twice. With merge_policy none nobody else QAs, so the per-task pass stays.
const CHUNK_QA = (plan.merge_policy || 'auto_on_signoff') !== 'none';
// Task branch is a SIBLING of the chunk branch (the "--" keeps it in the same path segment) so it
// never nests under the chunk branch ref, which would be a git file/directory conflict.
const taskBranch = (id) => `${CHUNK_BRANCH}--${id}`;

// The planner's tier is the size signal. A haiku or sonnet task is light: its verify and its
// gates overlap, per-task QA defers to the chunk sign-off, and reviewers run at default effort.
// An opus task keeps the full serial chain at high effort. Measured before this split: the
// chain cost 30 to 65 minutes per task regardless of size while builds and tests took seconds.
function isLight(t) {
  return !IS_RESEARCH && (t.model || 'sonnet') !== 'opus';
}
function reviewOpts(t, opts) {
  return isLight(t) ? opts : { ...opts, effort: 'high' };
}

phase('Worktrees')
// Serial creation avoids the .git/worktrees lock race that concurrent `git worktree add` hits.
const WT_SCHEMA = {
  type: 'object', required: ['worktrees'], properties: {
    worktrees: { type: 'array', items: { type: 'object', required: ['task_id', 'path', 'branch'],
      properties: { task_id: { type: 'string' }, path: { type: 'string' }, branch: { type: 'string' } } } },
  },
};
const wtPlan = (await timedAgent('worktrees', false, { worktrees: [] },
  `Create one git worktree per task, SERIALLY (never run two 'git worktree add' at once). Repo git root: ${GIT}.
First ensure the chunk branch exists: from ${GIT}, if branch "${CHUNK_BRANCH}" is missing,
  git branch "${CHUNK_BRANCH}" "${BASE}"  (create the ref without checking it out).
Then for each task id below, create a worktree on a NEW SIBLING branch off "${CHUNK_BRANCH}":
  git -C "${GIT}" worktree add "<repo_parent>/.hx-wt/${RUN}-${CHUNK}-<id>" -b "${CHUNK_BRANCH}--<id>" "${CHUNK_BRANCH}"
where <repo_parent> is the folder CONTAINING the repo, so ".hx-wt" is a sibling of the repo and never nests inside it.
If a branch "${CHUNK_BRANCH}--<id>" already exists from a prior run, delete it first (git branch -D) then re-add.
Task ids: ${tasks.map((t) => t.id).join(', ')}.
Return {worktrees:[{task_id, path, branch}]}. If an add fails, set that task's path to "ERROR: <reason>".`,
  { label: 'worktrees', phase: 'Worktrees', schema: WT_SCHEMA, effort: 'low' })) || { worktrees: [] };
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
  // Every role-dependent decision below uses the CANONICAL role, never the raw string.
  // Routing is deliberately tolerant (loop-devops, infra and ops all reach loop-devops), so a
  // safety check comparing the raw value would let "role":"loop-devops" reach the deploy
  // specialist with the guardrail silently omitted. Tolerant routing plus a strict check is
  // exactly how a guardrail goes missing.
  const role = normalizeRole(t.role);
  return `You are the ${role} producer for task ${t.id}, working ONLY inside your git worktree ${w.path} (cd there first; never touch the repo's main worktree). Model tier: ${model}.
Task: ${t.description}
Implement it, then run its verify commands as your own check: ${(t.verify_commands || []).join(' && ') || '(none given)'}.
Expect: ${t.expect || 'commands exit 0'}. Commit your work on branch ${w.branch} inside this worktree.
${role === 'devops' && !plan.allow_deploy ? 'DEPLOY GUARDRAIL: allow_deploy is false. Stage only, do NOT deploy/migrate/rotate. Return blocker "awaiting-deploy-approval".' : ''}
${isDesign(t) ? `DESIGN TASK. The evidence is VISUAL, not an exit code. Start the project's dev server, open the affected route, and capture a screenshot at a desktop width and a narrow width. Your work is not done until a screenshot SHOWS the change rendering correctly. Also run a Lighthouse accessibility pass and do not regress the score. Put the screenshot paths and the a11y score in "evidence".${(t.verify_commands || []).length ? '' : ' There are no verify commands for this task, so the screenshots ARE the verification.'}` : ''}
Telemetry: at start run: ${emit('producer.dispatched', 'controller', agentFor(t), t.id + ': ' + t.description, t.id)}
Return {passed, commit, blocker, evidence}.`;
}
function verifyPrompt(t, w) {
  return `Independently verify task ${t.id} from a CLEAN state inside worktree ${w.path} (cd there). Trust only your own evidence.
Re-run: ${(t.verify_commands || []).join(' && ') || '(none)'}. Expect: ${t.expect || 'exit 0'}.
${isDesign(t) ? 'This is a DESIGN task, so exit codes are not sufficient and an empty command list is not a pass. Re-take the screenshot yourself at a desktop and a narrow width, confirm it shows what "Expect" describes, and re-run the Lighthouse accessibility check to confirm no regression. If you cannot render the page, that is a FAIL with blocker "could not render", never a pass by default.' : ''}
Telemetry: at end run: ${emit('verify.result', 'loop-verifier-dev', 'controller', t.id + ' verify', t.id)}
Return {passed, blocker, evidence}.`;
}
function designGatePrompt(t, producerEvidence) {
  if (!isLight(t)) {
    return 'This is a VISUAL review: render the affected page, look at it at a desktop and a narrow width, and judge the RENDERED result, not just the diff. Confirm the project design system, spacing and color scheme were not altered beyond what the task asked for, and that the accessibility score did not regress.';
  }
  // The producer already rendered and the independent verifier is re-rendering right now, so
  // this reviewer judging from the producer's captures drops the third render without losing
  // an independent one: the verifier's own screenshots are still what decides the pass.
  return `This is a VISUAL review. The producer captured screenshots at a desktop and a narrow width plus a Lighthouse accessibility score; its evidence: ${producerEvidence.length ? producerEvidence.join(', ') : '(none reported)'}. Judge from those captures and the diff: confirm the project design system, spacing and color scheme were not altered beyond what the task asked for, and that the accessibility score did not regress. Do not start the dev server or re-render; the independent verifier is doing that separately. If the screenshots are missing or unreadable, return pass:false with notes "producer evidence missing".`;
}

// Give a dependent task its prerequisites' code before it produces, so same-chunk deps that share a
// file are not written blind. Only runs when there are passed in-chunk dep branches.
async function mergeDepsIntoWorktree(t, w, depBranches) {
  if (!depBranches.length) return true;
  const r = await timedAgent('deps', false, gateTimeout,
    `Inside git worktree ${w.path} (cd there), merge these dependency branches so this task builds on their work, one at a time: ${depBranches.join(', ')}. For each: git merge --no-edit <branch>; resolve any conflict keeping both intents, commit. Return {pass, notes}.`,
    { label: `deps:${t.id}`, phase: 'Execute', schema: GATE, agentType: 'loop-worker', effort: 'low' });
  return !!(r && r.pass);
}

function verify(t, w) {
  return timedAgent('verify', isDesign(t), verdictTimeout, verifyPrompt(t, w),
    reviewOpts(t, { label: `verify:${t.id}`, phase: 'Execute', schema: VERDICT, agentType: 'loop-verifier-dev' }));
}

// Resolve each requested gate to a reviewer and run them concurrently. A gate is one of two
// things and they must not be confused: the NAME OF A REVIEWER ("code-reviewer"), or a
// project-specific ASSERTION the diff must satisfy ("no-em-en-dashes", "prerender-intact").
// Measured on the real store, assertions are the majority: 23 of 42 requested gates. Both used
// to be silently dropped unless they exactly matched an agent name, so a task could ask for a
// design review, or for "seo-config-intact", and ship with neither checked. Now an assertion is
// handed to a reviewer as an explicit criterion instead of being discarded or failing the task
// outright. Returns {pass, why}; a dead (null) or timed-out reviewer is a FAIL, never a pass.
async function runGates(t, w, producerEvidence) {
  const requested = (t.gates || []).map(String);
  const resolved = [];
  const asCriteria = [];
  for (const g of requested) {
    const key = g.trim().toLowerCase();
    const mapped = GATE_AGENTS.includes(key) ? key : GATE_ALIAS[key];
    if (mapped) resolved.push({ gate: g, agentType: mapped, criterion: null });
    else {
      resolved.push({ gate: g, agentType: 'code-reviewer', criterion: g });
      asCriteria.push(g);
    }
  }
  // A design task always gets a design review, even if the plan forgot to ask for one.
  if (isDesign(t) && !resolved.some((r) => r.agentType === 'loop-designer')) {
    resolved.push({ gate: 'design-review', agentType: 'loop-designer', criterion: null });
  }
  if (asCriteria.length) {
    log(`task ${t.id}: gate(s) ${asCriteria.join(', ')} are not reviewer names, checking them as explicit criteria via code-reviewer`);
  }
  const gateResults = await parallel(resolved.map((r) => () =>
    timedAgent('gate', isDesign(t), gateTimeout,
      `Review task ${t.id}'s diff in worktree ${w.path} (cd there) for the "${r.gate}" gate.
${r.criterion
  ? `"${r.criterion}" is a PROJECT-SPECIFIC CONSTRAINT, not a review speciality. Work out what it requires from the task, the repo's conventions and its CLAUDE.md, then check the diff against exactly that one constraint. Judge only this constraint; other reviewers cover the rest. If you genuinely cannot determine what it means, return pass:false with notes saying so rather than guessing.`
  : r.agentType === 'loop-designer'
    ? designGatePrompt(t, producerEvidence)
    : `Review as ${r.agentType}.`}
Telemetry at end: ${emit('gate.result', r.agentType, 'controller', t.id + ' ' + r.gate, t.id)}. Return {pass, notes}.`,
      reviewOpts(t, { label: `gate:${t.id}:${r.gate}`, phase: 'Execute', schema: GATE, agentType: r.agentType }))));
  // Every requested gate is represented in `resolved`, so a dead critic still counts as a fail
  // (gateResults holds a null) and nothing passes by being unrecognized.
  if (gateResults.length !== resolved.length) return { pass: false, why: 'a gate reviewer returned nothing' };
  const failed = resolved.map((r, i) => ({ r, res: gateResults[i] })).filter((x) => !x.res || !x.res.pass);
  if (!failed.length) return { pass: true, why: null };
  return { pass: false, why: failed.map((x) => `gate ${x.r.gate}: ${(x.res && x.res.notes) || 'no result'}`).join('; ') };
}

// Sign-off after a passed verify: the skeptic (research), or gates then QA. For a light task the
// gates already ran alongside the verify and are passed in; its QA defers to the chunk sign-off
// when there will be one. Returns {pass, why}.
async function signoff(t, w, producerEvidence, gatesAlready) {
  if (IS_RESEARCH) {
    const sk = await timedAgent('skeptic', false, gateTimeout,
      `Try to REFUTE task ${t.id}'s claimed result in worktree ${w.path}; reject-if-uncertain. Telemetry at end: ${emit('skeptic.result', 'loop-skeptic-research', 'controller', t.id + ' skeptic', t.id)}. Return {pass:true only if you CANNOT refute, notes}.`,
      { label: `skeptic:${t.id}`, phase: 'Execute', schema: GATE, agentType: 'loop-skeptic-research', effort: 'high' });
    return (sk && sk.pass) ? { pass: true, why: null } : { pass: false, why: `skeptic: ${(sk && sk.notes) || 'no result'}` };
  }
  const gates = gatesAlready || await runGates(t, w, producerEvidence);
  if (!gates.pass) return gates;
  if (isLight(t) && CHUNK_QA) return { pass: true, why: null };
  const qa = await timedAgent('qa', isDesign(t), gateTimeout,
    `QA task ${t.id} in worktree ${w.path}: exercise real user journeys and edge cases beyond its narrow verify. Telemetry at end: ${emit('qa.result', 'loop-qa', 'controller', t.id + ' qa', t.id)}. Return {pass, notes}.`,
    reviewOpts(t, { label: `qa:${t.id}`, phase: 'Execute', schema: GATE, agentType: 'loop-qa' }));
  return (qa && qa.pass) ? { pass: true, why: null } : { pass: false, why: `QA withheld sign-off: ${(qa && qa.notes) || 'no result'}` };
}

// produce, verify, sign off, with ONE escalation up the model tier ladder on a verify failure.
// Light tasks overlap the verify with the gates; on a retry the diff changes, so the gates run
// again with it. Gate spend on a failed verify is the price of the overlap.
async function executeTask(t, w) {
  const start = Math.max(0, TIERS.indexOf(t.model || 'sonnet'));
  for (let step = 0; step < 2; step++) {
    const model = TIERS[Math.min(start + step, TIERS.length - 1)];
    const prod = await timedAgent('produce', isDesign(t), verdictTimeout, producePrompt(t, w, model),
      { label: `produce:${t.id}@${model}`, phase: 'Execute', schema: VERDICT, agentType: agentFor(t), model });
    if (prod && prod.blocker === 'awaiting-deploy-approval') return { passed: false, model_used: model, blocker: prod.blocker };
    const producerEvidence = (prod && prod.evidence) || [];
    let ver, gates = null;
    if (isLight(t)) {
      [ver, gates] = await Promise.all([verify(t, w), runGates(t, w, producerEvidence)]);
    } else {
      ver = await verify(t, w);
    }
    if (ver && ver.passed) {
      const signed = await signoff(t, w, producerEvidence, gates);
      const evidence = (ver.evidence || []).concat(producerEvidence);
      return { passed: signed.pass, model_used: model, evidence, commit: prod && prod.commit, blocker: signed.pass ? null : signed.why };
    }
    if (start + step + 1 >= TIERS.length) return { passed: false, model_used: model, blocker: (ver && ver.blocker) || 'verify failed at top tier' };
    // else: escalate one tier and retry once
  }
  return { passed: false, model_used: TIERS[Math.min(start + 1, TIERS.length - 1)], blocker: 'verify failed' };
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
    const v = await executeTask(t, w);
    return { task_id: t.id, passed: v.passed, model_used: v.model_used, blocker: v.blocker, branch: w.branch, merged: false, evidence: v.evidence };
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
  merged = (await timedAgent('merge', false, { merged: [], conflicts: [] },
    `Merge these task branches into "${CHUNK_BRANCH}" in ${GIT}, ONE AT A TIME in this exact order (never in parallel): ${toMerge.join(', ')}.
For each: git -C "${GIT}" checkout "${CHUNK_BRANCH}"; git -C "${GIT}" merge --no-ff --no-edit <branch>. On a conflict, resolve it against the updated chunk branch (keep both tasks' intent), commit, continue. Telemetry per merge: ${emit('merge', 'controller', CHUNK_BRANCH, 'merged a task branch', '')}.
Return {merged:[branch...], conflicts:[branch that needed manual help...]}.`,
    { label: 'merge', phase: 'Merge', schema: MERGE_SCHEMA, agentType: 'loop-worker', effort: 'high' })) || { merged: [], conflicts: [] };
}
const mergedSet = new Set(merged.merged || []);
for (const r of results) r.merged = !!(r.branch && mergedSet.has(r.branch));

phase('Cleanup')
// Always runs (even if nothing merged), so leftover worktrees and task branches never break a retry.
await timedAgent('cleanup', false, null,
  `Clean up this chunk's scratch git state in ${GIT}. 1) Remove every worktree whose path contains ".hx-wt/${RUN}-${CHUNK}-" (git prints worktree paths with forward slashes on every platform): from 'git -C "${GIT}" worktree list', for each match run git -C "${GIT}" worktree remove --force <path>; then git -C "${GIT}" worktree prune. 2) Delete every task branch matching "${CHUNK_BRANCH}--*": git -C "${GIT}" branch -D <branch> (they are either merged into ${CHUNK_BRANCH} already or are discarded failed attempts). Do NOT delete "${CHUNK_BRANCH}" itself. Return a one-line summary.`,
  { label: 'cleanup', phase: 'Cleanup', effort: 'low' });

log(`chunk ${CHUNK}: ${results.filter((r) => r.passed).length}/${results.length} passed, ${(merged.merged || []).length} merged`);
// A misrouted role is a planning bug that silently costs you a specialist, so say it out loud
// and hand it back to the controller rather than letting it hide in a green chunk.
if (roleWarnings.length) {
  for (const w of roleWarnings) {
    log(`task ${w.task_id}: unroutable role "${w.role}", fell back to ${w.fell_back_to}. Fix the role in tasks.json (bare noun: worker|designer|data-scientist|researcher|devops).`);
  }
}
return { chunk: CHUNK, results, role_warnings: roleWarnings };

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
