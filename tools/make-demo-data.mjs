// Synthetic demo-data generator for the Albert Console.
//
// Produces a fully fabricated run store and a set of fabricated Claude Code
// transcripts so a screenshotting pass can show the console fully alive with
// zero real user data. Everything here is invented: project names, goals, task
// titles, agent traffic and token counts. Nothing is read from the machine.
//
// Usage: node make-demo-data.mjs <output-dir>
//   writes <out>/agent-runs/  (run store the server reads via --store)
//         <out>/projects/     (transcripts the tailer reads via --projects)
//
// Real Node runs this, so Date.now() is used deliberately: every timestamp is
// relative to now, which is what makes the active run and active session read
// as live at screenshot time.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const outArg = process.argv[2];
if (!outArg) {
  console.error('usage: node make-demo-data.mjs <output-dir>');
  process.exit(1);
}

const OUT = outArg;
const RUNS_ROOT = join(OUT, 'agent-runs');
const PROJECTS_ROOT = join(OUT, 'projects');

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const agoIso = (sec) => iso(NOW - sec * 1000);

/* ---------------- fs helpers ---------------- */

function writeJson(file, obj) {
  writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

function writeJsonl(file, rows) {
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function writeText(file, text) {
  writeFileSync(file, text);
}

// Clean overwrite: remove only the two generated subtrees so pointing the
// script at a shared scratch dir cannot nuke unrelated siblings, then recreate.
rmSync(RUNS_ROOT, { recursive: true, force: true });
rmSync(PROJECTS_ROOT, { recursive: true, force: true });
mkdirSync(RUNS_ROOT, { recursive: true });
mkdirSync(PROJECTS_ROOT, { recursive: true });

/* ---------------- run store ---------------- */

// Four fabricated runs. The first is the live one the graph and ACTIVITY panel
// light up from; the rest are quieter history.
const RUNS = [
  { id: 'run-7f3ac2', project: 'acme-store', path: 'C:\\demo\\acme-store', status: 'running' },
  { id: 'run-4b19de', project: 'widgetworks-ui', path: 'C:\\demo\\widgetworks-ui', status: 'checkpoint' },
  { id: 'run-2c88a1', project: 'demo-blog', path: 'C:\\demo\\demo-blog', status: 'done' },
  { id: 'run-9de034', project: 'pixel-forge', path: 'C:\\demo\\pixel-forge', status: 'done' },
];
const ACTIVE_RUN_ID = RUNS[0].id;

writeJson(join(RUNS_ROOT, 'index.json'), {
  active_run_id: ACTIVE_RUN_ID,
  runs: RUNS.map((r) => ({ id: r.id, project_path: r.path, status: r.status })),
});

function makeTasks(run, chunkA, chunkB, doneThrough) {
  const tasks = [];
  let n = 0;
  const push = (chunk, def) => {
    n += 1;
    const id = 'T' + n;
    const done = n <= doneThrough;
    tasks.push({
      id,
      role: def.role,
      model: def.model,
      chunk,
      description: def.description,
      depends_on: def.depends_on || [],
      verify: {
        kind: 'dev',
        commands: def.commands,
        gates: def.gates,
        expect: def.expect,
      },
      status: done ? 'done' : 'pending',
      passes: done ? true : false,
    });
  };
  for (const d of chunkA) push('chunk-a', d);
  for (const d of chunkB) push('chunk-b', d);
  return { run_id: run.id, profile: 'dev', project_path: run.path, tasks };
}

function runEvents(run, timeline) {
  return timeline.map((t) => {
    const e = {
      ts: agoIso(t.sec),
      run_id: run.id,
      project: run.project,
      type: t.type,
      actor: t.actor,
      target: t.target ?? null,
      summary: t.summary,
    };
    if (t.task_id) e.task_id = t.task_id;
    if (t.chunk) e.chunk = t.chunk;
    if (t.iteration != null) e.iteration = t.iteration;
    return e;
  });
}

/* ---- run 1: acme-store, LIVE ---- */
{
  const run = RUNS[0];
  const dir = join(RUNS_ROOT, run.id);
  mkdirSync(dir, { recursive: true });

  writeText(join(dir, 'goal.md'), [
    '# Goal: checkout flow for acme-store',
    '',
    'Build a working checkout API for the acme-store demo backend so an active',
    'cart can be turned into a paid order with correct totals.',
    '',
    '## Acceptance criteria',
    '- POST /checkout converts an active cart into an order and returns an order id.',
    '- Line-item totals, tax, and shipping are computed server side and unit tested.',
    '- An idempotency key prevents a double charge on retry.',
    '- The build passes and test coverage stays above 85 percent.',
    '',
    '## Git-flow',
    'base_branch: develop',
    'stop_after: chunk',
    'merge_policy: squash-on-green',
    '',
  ].join('\n'));

  writeJson(join(dir, 'project.json'), {
    project_path: run.path,
    git_root: run.path,
    stack: ['node', 'express', 'postgres'],
    verify: { build: 'npm run build', test: 'npm test' },
    docs_convention: {},
    profile: 'dev',
  });

  writeJson(join(dir, 'tasks.json'), makeTasks(
    run,
    [
      { role: 'worker', model: 'sonnet', description: 'Define the order schema and migration', commands: ['npm run build', 'npm test'], gates: ['code-reviewer'], expect: 'migration applies and order table exists' },
      { role: 'worker', model: 'sonnet', description: 'Build the cart repository layer', commands: ['npm test'], gates: ['code-reviewer'], expect: 'cart CRUD covered by unit tests' },
      { role: 'worker', model: 'haiku', description: 'Add tax and shipping calculators', commands: ['npm test'], gates: ['code-reviewer'], expect: 'calculators match fixture totals' },
      { role: 'worker', model: 'sonnet', description: 'Add idempotency key handling', commands: ['npm test'], gates: ['code-reviewer'], expect: 'retry with same key returns first order' },
      { role: 'devops', model: 'haiku', description: 'Provision the staging deploy target', commands: ['npm run deploy:dry-run'], gates: [], expect: 'dry-run reports a clean plan' },
      { role: 'worker', model: 'sonnet', description: 'Wire cart totals into the order builder', commands: ['npm test'], gates: ['code-reviewer'], expect: 'order total equals cart total plus tax' },
    ],
    [
      { role: 'worker', model: 'opus', description: 'Build the checkout API endpoint', depends_on: ['T6'], commands: ['npm run build', 'npm test'], gates: ['code-reviewer'], expect: 'POST /checkout returns an order id' },
      { role: 'designer', model: 'sonnet', description: 'Design the order confirmation email', commands: ['npm run lint:email'], gates: ['code-reviewer'], expect: 'email renders in the three target clients' },
      { role: 'worker', model: 'sonnet', description: 'Add checkout integration tests', depends_on: ['T7'], commands: ['npm run test:int'], gates: ['code-reviewer'], expect: 'happy path and retry path both pass' },
      { role: 'worker', model: 'haiku', description: 'Add rate limiting to the checkout route', commands: ['npm test'], gates: ['code-reviewer'], expect: 'over-limit requests return 429' },
      { role: 'data-scientist', model: 'sonnet', description: 'Backfill order analytics events', commands: ['npm run test:analytics'], gates: [], expect: 'each order emits one analytics event' },
      { role: 'devops', model: 'haiku', description: 'Publish the checkout runbook', commands: [], gates: [], expect: 'runbook lists rollback steps' },
    ],
    6,
  ));

  writeJson(join(dir, 'progress.json'), {
    run_id: run.id,
    status: 'running',
    iteration: 7,
    iterations_spent: 7,
    tokens_spent: 812000,
    tasks_done: 6,
    stuck_counter: 0,
    iters_since_cleanup: 2,
    budget: { max_iterations: 40, max_tokens: 6000000, wall_deadline: iso(NOW + 6 * 3600 * 1000) },
    current_chunk: 'chunk-b in progress',
    last_action: 'dispatched loop-worker for T7 checkout endpoint',
    blockers: 'none',
  });

  writeJsonl(join(dir, 'events.jsonl'), runEvents(run, [
    { sec: 1800, type: 'run.init', actor: 'controller', target: null, iteration: 0, summary: 'run initialized for acme-store checkout flow' },
    { sec: 1740, type: 'plan.created', actor: 'loop-planner', target: null, iteration: 1, summary: 'planned 12 tasks across chunk-a schema and chunk-b endpoints' },
    { sec: 1500, type: 'producer.dispatched', actor: 'controller', target: 'loop-worker', task_id: 'T1', chunk: 'chunk-a', iteration: 1, summary: 'T1: define the order schema and migration' },
    { sec: 1440, type: 'task.done', actor: 'loop-worker', target: 'T1', task_id: 'T1', chunk: 'chunk-a', iteration: 1, summary: 'T1 done: order schema migration added' },
    { sec: 1380, type: 'verify.result', actor: 'loop-verifier-dev', target: 'T1', task_id: 'T1', chunk: 'chunk-a', iteration: 1, summary: 'T1 verify PASS 22/22' },
    { sec: 1200, type: 'producer.dispatched', actor: 'controller', target: 'loop-worker', task_id: 'T2', chunk: 'chunk-a', iteration: 2, summary: 'T2: build the cart repository layer' },
    { sec: 1140, type: 'task.done', actor: 'loop-worker', target: 'T2', task_id: 'T2', chunk: 'chunk-a', iteration: 2, summary: 'T2 done: cart repository implemented' },
    { sec: 1080, type: 'gate.result', actor: 'loop-qa', target: 'T2', task_id: 'T2', chunk: 'chunk-a', iteration: 2, summary: 'T2 code-reviewer PASS: no blocking issues' },
    { sec: 900, type: 'merge', actor: 'controller', target: 'harness/acme-checkout', chunk: 'chunk-a', iteration: 3, summary: 'merged chunk-a into harness/acme-checkout' },
    // Live batch, within the last ~90 seconds. loop-devops returns (closed);
    // loop-worker (T7) and loop-designer (T8) do not, so they light gold.
    { sec: 75, type: 'producer.dispatched', actor: 'controller', target: 'loop-devops', task_id: 'T5', chunk: 'chunk-b', iteration: 7, summary: 'T5: provision the staging deploy target' },
    { sec: 60, type: 'verify.result', actor: 'loop-devops', target: 'T5', task_id: 'T5', chunk: 'chunk-b', iteration: 7, summary: 'T5 deploy dry-run OK on staging' },
    { sec: 50, type: 'producer.dispatched', actor: 'controller', target: 'loop-worker', task_id: 'T7', chunk: 'chunk-b', iteration: 7, summary: 'T7: build the checkout API endpoint' },
    { sec: 42, type: 'producer.dispatched', actor: 'controller', target: 'loop-designer', task_id: 'T8', chunk: 'chunk-b', iteration: 7, summary: 'T8: design the order confirmation email' },
    { sec: 30, type: 'verify.result', actor: 'loop-verifier-dev', target: 'T6', task_id: 'T6', chunk: 'chunk-b', iteration: 7, summary: 'T6 verify PASS 88/88' },
    { sec: 18, type: 'gate.result', actor: 'loop-qa', target: 'T6', task_id: 'T6', chunk: 'chunk-b', iteration: 7, summary: 'T6 code-reviewer PASS: checkout totals correct' },
    { sec: 8, type: 'qa.result', actor: 'loop-qa', target: 'T6', task_id: 'T6', chunk: 'chunk-b', iteration: 7, summary: 'T6 QA PASS: cart edge cases covered' },
  ]));

  mkdirSync(join(dir, 'iterations', '1'), { recursive: true });
  mkdirSync(join(dir, 'iterations', '2'), { recursive: true });
  writeText(join(dir, 'iterations', '1', 'build.log'), [
    '> acme-store@1.0.0 build',
    '> tsc -p tsconfig.json && node scripts/bundle.mjs',
    '',
    'src/checkout/order.service.ts compiled',
    'src/cart/cart.repository.ts compiled',
    'bundle written to dist/server.js (412 kb)',
    'build OK in 3.8s',
    '',
  ].join('\n'));
  writeText(join(dir, 'iterations', '2', 'build.log'), [
    '> acme-store@1.0.0 test',
    '> node --test',
    '',
    'PASS src/checkout/order.service.spec.ts (41 tests)',
    'PASS src/cart/cart.repository.spec.ts (22 tests)',
    'Tests: 88 passed, 88 total',
    'Time: 5.104 s',
    '',
  ].join('\n'));
}

/* ---- run 2: widgetworks-ui, CHECKPOINT ---- */
{
  const run = RUNS[1];
  const dir = join(RUNS_ROOT, run.id);
  mkdirSync(dir, { recursive: true });

  writeText(join(dir, 'goal.md'), [
    '# Goal: refactor the widget grid in widgetworks-ui',
    '',
    'Rework the widget grid component so it renders large datasets without',
    'change-detection thrash and keeps the terminal-style theme intact.',
    '',
    '## Acceptance criteria',
    '- The grid uses OnPush change detection and trackBy on every list.',
    '- Scrolling a 5000 row dataset stays above 55 fps in the demo profile.',
    '- Existing unit tests keep passing and new ones cover the trackBy paths.',
    '',
    '## Git-flow',
    'base_branch: develop',
    'stop_after: chunk',
    'merge_policy: rebase-on-green',
    '',
  ].join('\n'));

  writeJson(join(dir, 'project.json'), {
    project_path: run.path,
    git_root: run.path,
    stack: ['angular', 'typescript', 'scss'],
    verify: { build: 'ng build', test: 'ng test --watch=false' },
    docs_convention: {},
    profile: 'dev',
  });

  writeJson(join(dir, 'tasks.json'), makeTasks(
    run,
    [
      { role: 'worker', model: 'sonnet', description: 'Extract the grid data source', commands: ['ng build'], gates: ['code-reviewer'], expect: 'data source compiles standalone' },
      { role: 'worker', model: 'sonnet', description: 'Move the grid to OnPush change detection', commands: ['ng test --watch=false'], gates: ['code-reviewer'], expect: 'no change-detection warnings in the profile' },
      { role: 'designer', model: 'sonnet', description: 'Restyle the grid header for the terminal theme', commands: ['ng build'], gates: ['code-reviewer'], expect: 'header matches the theme tokens' },
      { role: 'worker', model: 'haiku', description: 'Add trackBy to every grid list', commands: ['ng test --watch=false'], gates: ['code-reviewer'], expect: 'row identity is stable across updates' },
      { role: 'worker', model: 'sonnet', description: 'Virtualize the grid viewport', commands: ['ng test --watch=false'], gates: ['code-reviewer'], expect: 'only visible rows are in the DOM' },
    ],
    [
      { role: 'worker', model: 'sonnet', description: 'Add a fps benchmark harness', commands: ['ng test --watch=false'], gates: ['code-reviewer'], expect: 'benchmark reports frames above 55 fps' },
      { role: 'worker', model: 'haiku', description: 'Debounce the grid filter input', commands: ['ng test --watch=false'], gates: ['code-reviewer'], expect: 'filter fires at most once per 150 ms' },
      { role: 'designer', model: 'sonnet', description: 'Polish the empty-state panel', commands: ['ng build'], gates: ['code-reviewer'], expect: 'empty state matches the design board' },
      { role: 'worker', model: 'sonnet', description: 'Add keyboard navigation to the grid', commands: ['ng test --watch=false'], gates: ['code-reviewer'], expect: 'arrow keys move the focused cell' },
      { role: 'devops', model: 'haiku', description: 'Wire the grid demo into the preview build', commands: ['ng build'], gates: [], expect: 'preview build includes the grid route' },
    ],
    5,
  ));

  writeJson(join(dir, 'progress.json'), {
    run_id: run.id,
    status: 'checkpoint',
    iteration: 5,
    iterations_spent: 5,
    tokens_spent: 496000,
    tasks_done: 5,
    stuck_counter: 0,
    iters_since_cleanup: 1,
    budget: { max_iterations: 30, max_tokens: 4000000, wall_deadline: iso(NOW + 20 * 3600 * 1000) },
    current_chunk: 'chunk-a merged, awaiting go for chunk-b',
    last_action: 'reached checkpoint after chunk-a merge',
    note: 'paused at checkpoint for a design review of the grid header',
  });

  writeJsonl(join(dir, 'events.jsonl'), runEvents(run, [
    { sec: 7200, type: 'run.init', actor: 'controller', target: null, iteration: 0, summary: 'run initialized for widgetworks-ui grid refactor' },
    { sec: 7000, type: 'plan.created', actor: 'loop-planner', target: null, iteration: 1, summary: 'planned 10 tasks across chunk-a and chunk-b' },
    { sec: 6600, type: 'producer.dispatched', actor: 'controller', target: 'loop-worker', task_id: 'T1', chunk: 'chunk-a', iteration: 1, summary: 'T1: extract the grid data source' },
    { sec: 6400, type: 'task.done', actor: 'loop-worker', target: 'T1', task_id: 'T1', chunk: 'chunk-a', iteration: 1, summary: 'T1 done: grid data source extracted' },
    { sec: 6000, type: 'verify.result', actor: 'loop-verifier-dev', target: 'T1', task_id: 'T1', chunk: 'chunk-a', iteration: 1, summary: 'T1 verify PASS 30/30' },
    { sec: 5400, type: 'producer.dispatched', actor: 'controller', target: 'loop-designer', task_id: 'T3', chunk: 'chunk-a', iteration: 3, summary: 'T3: restyle the grid header for the terminal theme' },
    { sec: 5200, type: 'gate.result', actor: 'loop-qa', target: 'T3', task_id: 'T3', chunk: 'chunk-a', iteration: 3, summary: 'T3 code-reviewer PASS: theme tokens consistent' },
    { sec: 4800, type: 'checkpoint', actor: 'controller', target: null, chunk: 'chunk-a', iteration: 5, summary: 'checkpoint: chunk-a merged, pausing for design review' },
  ]));
}

/* ---- run 3: demo-blog, DONE ---- */
{
  const run = RUNS[2];
  const dir = join(RUNS_ROOT, run.id);
  mkdirSync(dir, { recursive: true });

  writeText(join(dir, 'goal.md'), [
    '# Goal: add dark mode to demo-blog',
    '',
    'Give the demo-blog static site a dark theme that respects the reader system',
    'preference and can be toggled by hand.',
    '',
    '## Acceptance criteria',
    '- The site follows prefers-color-scheme on first load.',
    '- A toggle lets the reader override the system preference and it persists.',
    '- Color contrast passes AA in both themes.',
    '',
    '## Git-flow',
    'base_branch: develop',
    'stop_after: run',
    'merge_policy: squash-on-green',
    '',
  ].join('\n'));

  writeJson(join(dir, 'project.json'), {
    project_path: run.path,
    git_root: run.path,
    stack: ['eleventy', 'markdown', 'css'],
    verify: { build: 'npm run build', test: 'npm run test:links' },
    docs_convention: {},
    profile: 'dev',
  });

  writeJson(join(dir, 'tasks.json'), makeTasks(
    run,
    [
      { role: 'designer', model: 'sonnet', description: 'Define the dark theme color tokens', commands: ['npm run build'], gates: ['code-reviewer'], expect: 'tokens cover text, surface, and accent' },
      { role: 'worker', model: 'haiku', description: 'Add a prefers-color-scheme stylesheet', commands: ['npm run build'], gates: ['code-reviewer'], expect: 'dark theme applies with no toggle' },
      { role: 'worker', model: 'sonnet', description: 'Build the theme toggle and persist it', commands: ['npm run test:links'], gates: ['code-reviewer'], expect: 'choice survives a reload' },
      { role: 'worker', model: 'haiku', description: 'Add a theme meta color tag', commands: ['npm run build'], gates: ['code-reviewer'], expect: 'browser chrome matches the theme' },
      { role: 'designer', model: 'sonnet', description: 'Recolor the code block syntax theme', commands: ['npm run build'], gates: ['code-reviewer'], expect: 'code blocks stay readable in dark' },
    ],
    [
      { role: 'worker', model: 'haiku', description: 'Audit color contrast in both themes', commands: ['npm run test:a11y'], gates: ['code-reviewer'], expect: 'AA contrast passes everywhere' },
      { role: 'worker', model: 'sonnet', description: 'Add a no-flash theme boot script', commands: ['npm run test:links'], gates: ['code-reviewer'], expect: 'no light flash on a dark reload' },
      { role: 'devops', model: 'haiku', description: 'Rebuild and publish the preview', commands: ['npm run build'], gates: [], expect: 'preview shows both themes' },
    ],
    8,
  ));

  writeJson(join(dir, 'progress.json'), {
    run_id: run.id,
    status: 'done',
    iteration: 6,
    iterations_spent: 6,
    tokens_spent: 318000,
    tasks_done: 5,
    stuck_counter: 0,
    iters_since_cleanup: 0,
    budget: { max_iterations: 20, max_tokens: 2500000, wall_deadline: iso(NOW - 40 * 3600 * 1000) },
    current_chunk: 'complete',
    last_action: 'merged and closed the run',
    note: 'completed and merged, dark mode shipped',
  });

  writeJsonl(join(dir, 'events.jsonl'), runEvents(run, [
    { sec: 190000, type: 'run.init', actor: 'controller', target: null, iteration: 0, summary: 'run initialized for demo-blog dark mode' },
    { sec: 189000, type: 'plan.created', actor: 'loop-planner', target: null, iteration: 1, summary: 'planned 5 tasks across chunk-a and chunk-b' },
    { sec: 188000, type: 'producer.dispatched', actor: 'controller', target: 'loop-worker', task_id: 'T2', chunk: 'chunk-a', iteration: 2, summary: 'T2: add a prefers-color-scheme stylesheet' },
    { sec: 187500, type: 'task.done', actor: 'loop-worker', target: 'T2', task_id: 'T2', chunk: 'chunk-a', iteration: 2, summary: 'T2 done: dark stylesheet added' },
    { sec: 187000, type: 'verify.result', actor: 'loop-verifier-dev', target: 'T2', task_id: 'T2', chunk: 'chunk-a', iteration: 2, summary: 'T2 verify PASS 12/12' },
    { sec: 186000, type: 'gate.result', actor: 'loop-qa', target: 'T2', task_id: 'T2', chunk: 'chunk-a', iteration: 2, summary: 'T2 code-reviewer PASS: tokens applied cleanly' },
    { sec: 185000, type: 'merge', actor: 'controller', target: 'harness/demo-blog-dark', iteration: 6, summary: 'merged all chunks, run complete' },
    { sec: 184900, type: 'notify', actor: 'controller', target: null, iteration: 6, summary: 'run complete, notified the owner' },
  ]));
}

/* ---- run 4: pixel-forge, DONE ---- */
{
  const run = RUNS[3];
  const dir = join(RUNS_ROOT, run.id);
  mkdirSync(dir, { recursive: true });

  writeText(join(dir, 'goal.md'), [
    '# Goal: fix collision detection in pixel-forge',
    '',
    'Stop the player sprite from clipping through walls at high speed in the',
    'pixel-forge demo game.',
    '',
    '## Acceptance criteria',
    '- The sprite never passes through a wall at any tested velocity.',
    '- The physics step stays inside its frame budget.',
    '- A regression test covers the fast-contact case.',
    '',
    '## Git-flow',
    'base_branch: develop',
    'stop_after: run',
    'merge_policy: squash-on-green',
    '',
  ].join('\n'));

  writeJson(join(dir, 'project.json'), {
    project_path: run.path,
    git_root: run.path,
    stack: ['typescript', 'canvas', 'vite'],
    verify: { build: 'npm run build', test: 'npm run test' },
    docs_convention: {},
    profile: 'dev',
  });

  writeJson(join(dir, 'tasks.json'), makeTasks(
    run,
    [
      { role: 'worker', model: 'sonnet', description: 'Reproduce the wall clip bug in a test', commands: ['npm run test'], gates: ['code-reviewer'], expect: 'a failing test captures the clip' },
      { role: 'worker', model: 'opus', description: 'Switch to swept collision detection', commands: ['npm run test'], gates: ['code-reviewer'], expect: 'the sprite stops at the wall' },
      { role: 'worker', model: 'haiku', description: 'Clamp velocity at contact', commands: ['npm run test'], gates: ['code-reviewer'], expect: 'no tunneling at max speed' },
      { role: 'worker', model: 'sonnet', description: 'Add sub-stepping for high velocity', commands: ['npm run test'], gates: ['code-reviewer'], expect: 'fast frames sub-step correctly' },
    ],
    [
      { role: 'worker', model: 'sonnet', description: 'Add a fast-contact regression test', commands: ['npm run test'], gates: ['code-reviewer'], expect: 'regression test guards the fix' },
      { role: 'data-scientist', model: 'sonnet', description: 'Log collision events for tuning', commands: ['npm run test'], gates: [], expect: 'each contact emits one log line' },
      { role: 'worker', model: 'haiku', description: 'Profile the physics step budget', commands: ['npm run test'], gates: ['code-reviewer'], expect: 'physics step stays under 4 ms' },
      { role: 'devops', model: 'haiku', description: 'Publish the collision demo build', commands: ['npm run build'], gates: [], expect: 'demo build runs at 60 fps' },
    ],
    8,
  ));

  writeJson(join(dir, 'progress.json'), {
    run_id: run.id,
    status: 'done',
    iteration: 4,
    iterations_spent: 4,
    tokens_spent: 274000,
    tasks_done: 4,
    stuck_counter: 0,
    iters_since_cleanup: 0,
    budget: { max_iterations: 16, max_tokens: 2000000, wall_deadline: iso(NOW - 60 * 3600 * 1000) },
    current_chunk: 'complete',
    last_action: 'merged and closed the run',
    note: 'completed and merged, tunneling fixed',
  });

  writeJsonl(join(dir, 'events.jsonl'), runEvents(run, [
    { sec: 270000, type: 'run.init', actor: 'controller', target: null, iteration: 0, summary: 'run initialized for pixel-forge collision fix' },
    { sec: 269000, type: 'plan.created', actor: 'loop-planner', target: null, iteration: 1, summary: 'planned 4 tasks across chunk-a and chunk-b' },
    { sec: 268000, type: 'producer.dispatched', actor: 'controller', target: 'loop-worker', task_id: 'T2', chunk: 'chunk-a', iteration: 2, summary: 'T2: switch to swept collision detection' },
    { sec: 267500, type: 'task.done', actor: 'loop-worker', target: 'T2', task_id: 'T2', chunk: 'chunk-a', iteration: 2, summary: 'T2 done: swept collision landed' },
    { sec: 267000, type: 'verify.result', actor: 'loop-verifier-dev', target: 'T2', task_id: 'T2', chunk: 'chunk-a', iteration: 2, summary: 'T2 verify PASS 17/17' },
    { sec: 266000, type: 'gate.result', actor: 'loop-qa', target: 'T2', task_id: 'T2', chunk: 'chunk-a', iteration: 2, summary: 'T2 code-reviewer PASS: no tunneling observed' },
    { sec: 265000, type: 'merge', actor: 'controller', target: 'harness/pixel-forge-collision', iteration: 4, summary: 'merged all chunks, run complete' },
  ]));
}

/* ---------------- transcripts (Claude Code sessions) ---------------- */

const slugForCwd = (cwd) => cwd.replace(/[:\\]/g, '-');

function usage(inp, out, cacheRead, cacheCreate) {
  return {
    input_tokens: inp,
    output_tokens: out,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreate,
  };
}

function envelope(sessionId, cwd, sec, type) {
  return {
    parentUuid: null,
    isSidechain: false,
    type,
    uuid: randomUUID(),
    timestamp: agoIso(sec),
    sessionId,
    cwd,
    gitBranch: 'main',
    version: '2.1.0',
    userType: 'external',
    entrypoint: 'claude-vscode',
  };
}

function titleLine(sid, cwd, sec, aiTitle) {
  const e = envelope(sid, cwd, sec, 'ai-title');
  e.aiTitle = aiTitle;
  return e;
}

function textLine(sid, cwd, sec, text, u) {
  const e = envelope(sid, cwd, sec, 'assistant');
  e.message = { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text }], usage: u };
  return e;
}

function dispatchLine(sid, cwd, sec, toolId, description, subagentType, u) {
  const e = envelope(sid, cwd, sec, 'assistant');
  e.message = {
    role: 'assistant',
    content: [{
      type: 'tool_use',
      id: toolId,
      name: 'Agent',
      input: { description, prompt: '(omitted)', subagent_type: subagentType, run_in_background: false },
    }],
    usage: u,
  };
  return e;
}

function resultLine(sid, cwd, sec, toolId, agentType, model, durMs, tokens, toolCount, agentNum) {
  const e = envelope(sid, cwd, sec, 'user');
  e.message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'done' }] };
  e.toolUseResult = {
    status: 'completed',
    agentId: 'a' + agentNum,
    agentType,
    resolvedModel: model,
    totalDurationMs: durMs,
    totalTokens: tokens,
    totalToolUseCount: toolCount,
  };
  return e;
}

function writeSession(cwd, lines) {
  const sid = randomUUID();
  const dir = join(PROJECTS_ROOT, slugForCwd(cwd));
  mkdirSync(dir, { recursive: true });
  writeJsonl(join(dir, sid + '.jsonl'), lines.map((fn) => fn(sid)));
  return sid;
}

// S1: acme-store, ACTIVE. Newest line 40 s ago; two open dispatches (no result)
// so general-purpose and Explore light on the graph and the session reads ACTIVE.
writeSession('C:\\demo\\acme-store', [
  (s) => titleLine(s, 'C:\\demo\\acme-store', 900, 'Build the checkout flow for acme-store'),
  (s) => textLine(s, 'C:\\demo\\acme-store', 880, 'Reviewing the cart module and mapping the checkout endpoints.', usage(1500, 950, 52000, 4200)),
  (s) => dispatchLine(s, 'C:\\demo\\acme-store', 820, 'toolu_101', 'Find the cart total bug', 'general-purpose', usage(400, 120, 53000, 300)),
  (s) => resultLine(s, 'C:\\demo\\acme-store', 700, 'toolu_101', 'general-purpose', 'claude-haiku-4-5', 5200, 48000, 3, 101),
  (s) => textLine(s, 'C:\\demo\\acme-store', 650, 'Cart total off-by-one confirmed, drafting the fix.', usage(1800, 1100, 54000, 5200)),
  (s) => dispatchLine(s, 'C:\\demo\\acme-store', 600, 'toolu_102', 'Map the payment module', 'Explore', usage(380, 140, 55000, 280)),
  (s) => resultLine(s, 'C:\\demo\\acme-store', 520, 'toolu_102', 'Explore', 'claude-haiku-4-5', 8100, 61000, 5, 102),
  (s) => textLine(s, 'C:\\demo\\acme-store', 120, 'Payment module mapped, wiring the confirmation email next.', usage(2100, 1300, 56000, 6100)),
  (s) => dispatchLine(s, 'C:\\demo\\acme-store', 55, 'toolu_103', 'Wire the order confirmation email', 'general-purpose', usage(420, 160, 57000, 320)),
  (s) => dispatchLine(s, 'C:\\demo\\acme-store', 40, 'toolu_104', 'Trace the checkout session state', 'Explore', usage(410, 150, 57500, 310)),
]);

// S2: widgetworks-ui, idle ~15 min, still today (feeds TODAY burn).
writeSession('C:\\demo\\widgetworks-ui', [
  (s) => titleLine(s, 'C:\\demo\\widgetworks-ui', 2400, 'Refactor the widget grid component in widgetworks-ui'),
  (s) => textLine(s, 'C:\\demo\\widgetworks-ui', 2300, 'Auditing the grid component for change-detection thrash.', usage(1600, 1000, 40000, 3800)),
  (s) => dispatchLine(s, 'C:\\demo\\widgetworks-ui', 2100, 'toolu_201', 'Review the grid change detection', 'code-reviewer', usage(360, 110, 41000, 260)),
  (s) => resultLine(s, 'C:\\demo\\widgetworks-ui', 1900, 'toolu_201', 'code-reviewer', 'claude-sonnet-5', 12000, 72000, 6, 201),
  (s) => textLine(s, 'C:\\demo\\widgetworks-ui', 1500, 'Applying OnPush and trackBy across the grid lists.', usage(1900, 1200, 42000, 4400)),
  (s) => dispatchLine(s, 'C:\\demo\\widgetworks-ui', 1200, 'toolu_202', 'Run the widget unit tests', 'test-runner', usage(340, 100, 43000, 240)),
  (s) => resultLine(s, 'C:\\demo\\widgetworks-ui', 900, 'toolu_202', 'test-runner', 'claude-haiku-4-5', 9400, 38000, 4, 202),
]);

// S3: demo-blog, idle ~3 h.
writeSession('C:\\demo\\demo-blog', [
  (s) => titleLine(s, 'C:\\demo\\demo-blog', 12000, 'Add dark mode to the demo-blog static site'),
  (s) => textLine(s, 'C:\\demo\\demo-blog', 11800, 'Scanning the theme tokens and layout partials.', usage(1400, 900, 30000, 3200)),
  (s) => dispatchLine(s, 'C:\\demo\\demo-blog', 11600, 'toolu_301', 'Find the theme token definitions', 'Explore', usage(320, 100, 31000, 220)),
  (s) => resultLine(s, 'C:\\demo\\demo-blog', 11400, 'toolu_301', 'Explore', 'claude-haiku-4-5', 6200, 41000, 3, 301),
  (s) => textLine(s, 'C:\\demo\\demo-blog', 11000, 'Adding prefers-color-scheme tokens and a toggle.', usage(1700, 1050, 32000, 3900)),
  (s) => dispatchLine(s, 'C:\\demo\\demo-blog', 10900, 'toolu_302', 'Audit color contrast', 'general-purpose', usage(300, 90, 33000, 200)),
  (s) => resultLine(s, 'C:\\demo\\demo-blog', 10800, 'toolu_302', 'general-purpose', 'claude-sonnet-5', 15000, 55000, 7, 302),
]);

// S4: pixel-forge, idle ~26 h.
writeSession('C:\\demo\\pixel-forge', [
  (s) => titleLine(s, 'C:\\demo\\pixel-forge', 95000, 'Fix collision detection in pixel-forge'),
  (s) => textLine(s, 'C:\\demo\\pixel-forge', 94800, 'Reproducing the wall clip bug in the physics step.', usage(1300, 850, 28000, 3000)),
  (s) => dispatchLine(s, 'C:\\demo\\pixel-forge', 94600, 'toolu_401', 'Reproduce the collision bug', 'general-purpose', usage(300, 90, 29000, 210)),
  (s) => resultLine(s, 'C:\\demo\\pixel-forge', 94000, 'toolu_401', 'general-purpose', 'claude-haiku-4-5', 7200, 44000, 4, 401),
  (s) => textLine(s, 'C:\\demo\\pixel-forge', 93600, 'Clamping velocity at contact, added a regression test.', usage(1600, 980, 30000, 3600)),
]);

// S5: acme-store harness session, idle ~2 days. Dispatches loop-* agents so it
// reads as a harness run and enriches the harness band.
writeSession('C:\\demo\\acme-store', [
  (s) => titleLine(s, 'C:\\demo\\acme-store', 174000, 'Run the acme-store checkout hardening loop'),
  (s) => textLine(s, 'C:\\demo\\acme-store', 173800, 'Kicking off the agent loop for checkout hardening.', usage(2000, 1300, 60000, 5000)),
  (s) => dispatchLine(s, 'C:\\demo\\acme-store', 173600, 'toolu_501', 'Harden the checkout endpoint', 'loop-worker', usage(350, 120, 61000, 250)),
  (s) => resultLine(s, 'C:\\demo\\acme-store', 173400, 'toolu_501', 'loop-worker', 'claude-sonnet-5', 42000, 88000, 9, 501),
  (s) => dispatchLine(s, 'C:\\demo\\acme-store', 173200, 'toolu_502', 'Verify the checkout endpoint', 'loop-verifier-dev', usage(330, 110, 62000, 240)),
  (s) => resultLine(s, 'C:\\demo\\acme-store', 172800, 'toolu_502', 'loop-verifier-dev', 'claude-haiku-4-5', 18000, 52000, 5, 502),
]);

console.log('demo data written to ' + OUT);
console.log('  runs:     ' + RUNS.length + ' (active ' + ACTIVE_RUN_ID + ')');
console.log('  sessions: 5 transcripts under projects/');
