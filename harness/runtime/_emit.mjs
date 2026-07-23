#!/usr/bin/env node
// _emit.mjs - append one event line to a run's events.jsonl in this store.
// Zero dependencies, Node builtins only, so the harness can call it from anywhere.
//
// Usage:
//   node _emit.mjs <run-id> <type> <actor> <target> <summary> [jsonData]
//                  [--task <id>] [--iter <n>] [--chunk <id>] [--status <status>]

import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import os from "node:os";

const USAGE =
  'usage: node _emit.mjs <run-id> <type> <actor> <target> <summary> [jsonData] [--task <id>] [--iter <n>] [--chunk <id>] [--status <status>]';

function fail(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

// Files in this store may carry a UTF-8 BOM (PowerShell 5.1 writers); JSON.parse rejects it.
function readJson(path) {
  const raw = readFileSync(path, "utf8");
  const noBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return JSON.parse(noBom.replace(/\r/g, ""));
}

// Sync sleep: _emit is a short-lived CLI with nothing else on its event loop,
// so blocking the thread between rename attempts is the simplest correct wait.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Write via a temp file + rename so a concurrent reader never observes a
// half-written index.json/progress.json: renameSync maps to MoveFileEx with
// MOVEFILE_REPLACE_EXISTING, which swaps the directory entry atomically on a
// same-volume NTFS path. The temp name carries the pid so two _emit processes
// racing on the same target cannot interleave writes into one temp file.
//
// Windows caveat, measured on this box: replacing a file that another process
// currently has open fails with EPERM (~84% of attempts against a reader in a
// tight loop). The console reads index.json on every API request, so this is
// the common case, not a corner. Retry with backoff rather than failing the
// status update -- a lost write here is exactly what the atomicity fix exists
// to prevent.
function writeJson(path, obj) {
  const tmp = `${path}.${process.pid}.tmp`;
  const body = JSON.stringify(obj, null, 2) + "\n";
  try {
    writeFileSync(tmp, body, "utf8");
    let lastErr;
    for (const delay of [0, 5, 10, 20, 40, 80, 120, 200, 300, 400]) {
      if (delay) sleepSync(delay);
      try {
        renameSync(tmp, path);
        return;
      } catch (e) {
        // EPERM/EACCES/EBUSY here mean a reader holds the target open; retry.
        if (e.code !== "EPERM" && e.code !== "EACCES" && e.code !== "EBUSY") throw e;
        lastErr = e;
      }
    }
    throw lastErr;
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // Temp file never got created, or is already gone; the original error wins.
    }
    throw e;
  }
}

// tmp+rename makes a single write atomic, but atomicity is not mutual exclusion:
// index.json is a shared registry where every writer rewrites the WHOLE object,
// so two _emit processes that read it, each edit their own run's entry, then
// write it back will clobber each other (last rename wins, both exit 0).
// Measured on this store: 8 concurrent --status writers, only 6/8 entries
// survived; widening the read-write window to ~50ms dropped that to 1/8.
// So serialize the whole read-modify-write of index.json behind an exclusive
// lock file. progress.json needs none: it lives in the run folder and has
// exactly one writer.
//
// The two timings below are related: LOCK_WAIT_MS must exceed the longest a
// holder can legitimately take (writeJson's own EPERM ladder, ~1.2s) so waiters
// do not fail while someone is making progress, and LOCK_STALE_MS must exceed
// LOCK_WAIT_MS so a slow-but-alive holder is never mistaken for a dead one.
const LOCK_LADDER = [0, 5, 10, 20, 40, 80, 120, 200, 300, 400, 500, 500, 500, 500, 500, 500, 500, 500];
const LOCK_STALE_MS = 10000;

// 'wx' fails if the file exists, which is the atomic test-and-set this needs.
function acquireLock(lockPath) {
  let lastErr;
  for (const delay of LOCK_LADDER) {
    if (delay) sleepSync(delay);
    try {
      return openSync(lockPath, "wx");
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      lastErr = e;
      // A holder only ever keeps this for one read+write. An older lock means
      // its owner was killed mid-update; steal it rather than wedging every
      // future writer on a file nobody will ever release.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath);
      } catch {
        // Lock vanished (released or stolen) between the two calls; just retry.
      }
    }
  }
  throw new Error(`timed out waiting for ${lockPath}: ${lastErr.message}`);
}

function withLock(lockPath, fn) {
  const fd = acquireLock(lockPath);
  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Descriptor already gone; releasing the name below is what matters.
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // Already stolen as stale by a waiter; it owns the lock now, not us.
    }
  }
}

// --- argument parsing ---------------------------------------------------

const argv = process.argv.slice(2);
const positionals = [];
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--task" || a === "--iter" || a === "--chunk" || a === "--status") {
    const v = argv[++i];
    if (v === undefined) fail(`missing value for ${a}`);
    flags[a.slice(2)] = v;
  } else if (a.startsWith("--")) {
    fail(`unknown flag ${a}\n${USAGE}`);
  } else {
    positionals.push(a);
  }
}

if (positionals.length < 5 || positionals.length > 6) fail(USAGE);
const [runId, type, actor, target, summary, jsonData] = positionals;

let data;
if (jsonData !== undefined) {
  try {
    data = JSON.parse(jsonData);
  } catch {
    fail(`jsonData is not valid JSON: ${jsonData}`);
  }
}

let iteration;
if (flags.iter !== undefined) {
  iteration = Number(flags.iter);
  if (!Number.isFinite(iteration)) fail(`--iter must be a number, got: ${flags.iter}`);
}

// --- locate the store and the run ----------------------------------------

// The store root is the global agent-runs folder under the user's home, so
// neither the cwd nor this script's own location matters.
const storeRoot = join(os.homedir(), ".claude", "agent-runs");

// The contract: this script never writes outside the run folder plus the two
// registry files and index.json's lock. A run-id must therefore be a plain
// directory name; anything
// with separators, '', '.', or '..' could escape the store via join().
if (runId === "." || runId === ".." || !/^[A-Za-z0-9._-]+$/.test(runId)) {
  fail(`invalid run-id: ${JSON.stringify(runId)} (must match [A-Za-z0-9._-]+ and not be '.' or '..')`);
}
const runDir = join(storeRoot, runId);
if (!resolve(runDir).startsWith(resolve(storeRoot) + sep)) {
  fail(`run-id resolves outside the store: ${JSON.stringify(runId)}`);
}

let runExists = false;
try {
  runExists = statSync(runDir).isDirectory();
} catch {
  runExists = false;
}
if (!runExists) fail(`run folder does not exist: ${runDir}`);

// project = basename of the registered project_path; unregistered runs fall
// back to the run-id with its date and any suffix stripped (run ids are
// <project>-<slug>-<YYYY-MM-DD>, sometimes with a trailing "-chunkN" style suffix).
let index = null;
let project = runId.replace(/-\d{4}-\d{2}-\d{2}(-.*)?$/, "");
let projectFromIndex = false;
const indexPath = join(storeRoot, "index.json");
if (existsSync(indexPath)) {
  try {
    index = readJson(indexPath);
    const entry = Array.isArray(index?.runs) ? index.runs.find((r) => r && r.id === runId) : null;
    if (entry && typeof entry.project_path === "string" && entry.project_path.length > 0) {
      // Registry paths are Windows-style; basename() on win32 handles both separators,
      // but normalize backslashes anyway so this also behaves under a POSIX node.
      project = basename(entry.project_path.replace(/\\/g, "/"));
      projectFromIndex = true;
    }
  } catch (e) {
    fail(`cannot parse ${indexPath}: ${e.message}`);
  }
}
if (!projectFromIndex) {
  // Heuristic fallback: still just a slug, not the project_path basename.
  process.stderr.write(
    `warning: run ${runId} is not registered in index.json; derived project "${project}" from the run id\n`
  );
}

// --- pre-validate the --status sync ---------------------------------------

// index.json (registry) and progress.json (live) drift apart when written
// separately; --status writes both in one shot to keep them agreeing.
// Read and validate BEFORE appending the event: exiting 1 after the append
// would make retrying callers duplicate the event line.
const progressPath = join(runDir, "progress.json");
let progress = null;
let indexEntry = null;
if (flags.status !== undefined) {
  try {
    progress = readJson(progressPath);
  } catch (e) {
    fail(`cannot read progress.json for --status: ${e.message}`);
  }
  if (index && Array.isArray(index.runs)) {
    indexEntry = index.runs.find((r) => r && r.id === runId) || null;
  }
}

// --- build and append the event ------------------------------------------

const event = {
  ts: new Date().toISOString(),
  run_id: runId,
  project,
  type,
  actor,
  target,
};
if (flags.task !== undefined) event.task_id = flags.task;
if (flags.chunk !== undefined) event.chunk = flags.chunk;
if (iteration !== undefined) event.iteration = iteration;
event.summary = summary;
if (data !== undefined) event.data = data;

try {
  appendFileSync(join(runDir, "events.jsonl"), JSON.stringify(event) + "\n", "utf8");
} catch (e) {
  fail(`cannot append to events.jsonl: ${e.message}`);
}

// --- optional status sync (validated above, before the append) -------------

if (flags.status !== undefined) {
  try {
    progress.status = flags.status;
    writeJson(progressPath, progress);
  } catch (e) {
    fail(`cannot update progress.json status: ${e.message}`);
  }

  if (indexEntry) {
    try {
      withLock(`${indexPath}.lock`, () => {
        // Re-read under the lock. `index` was parsed before the event append and
        // may be stale by now; writing that copy back would revert whatever a
        // concurrent _emit committed for a different run in the meantime.
        const current = readJson(indexPath);
        const entry = Array.isArray(current?.runs) ? current.runs.find((r) => r && r.id === runId) : null;
        if (!entry) return;
        entry.status = flags.status;
        writeJson(indexPath, current);
      });
    } catch (e) {
      fail(`cannot update index.json status: ${e.message}`);
    }
  }
}

process.exit(0);
