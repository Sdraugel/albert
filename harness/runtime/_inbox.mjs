#!/usr/bin/env node
// _inbox.mjs - chat inbox for a run in this store: queue messages to the
// orchestrator, list pending ones, reply-and-archive. Sibling of _emit.mjs;
// zero dependencies, Node builtins only, so both the harness and the chat
// backend can call it from anywhere.
//
// Usage:
//   node _inbox.mjs write <run-id> --type steer|question|info --text "<text>"
//                   [--from <who>] [--session <chat-session-id>]
//   node _inbox.mjs list  <run-id>
//   node _inbox.mjs reply <run-id> <filename> --text "<answer>"
//
// Layout inside a run folder:
//   inbox\<epoch_ms>-<pid>-<seq>.json     pending message
//   inbox\processed\<same-filename>       archived after reply
//
// write appends a chat.msg event and reply appends a chat.reply event to the
// run's events.jsonl, so the console Comms feed shows the exchange without any
// console changes. reply archives the file only AFTER the event is durably
// appended: a crash in between re-delivers the message on the next wake
// (at-least-once), which is safe because steers are declarative.
//
// ALBERT_STORE_ROOT overrides the store location for tests against demo data.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import os from "node:os";

const USAGE = [
  "usage:",
  '  node _inbox.mjs write <run-id> --type steer|question|info --text "<text>" [--from <who>] [--session <id>]',
  "  node _inbox.mjs list  <run-id>",
  '  node _inbox.mjs reply <run-id> <filename> --text "<answer>"',
].join("\n");

const MSG_TYPES = ["steer", "question", "info"];

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

// Sync sleep: this is a short-lived CLI with nothing else on its event loop.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Same EPERM/EACCES/EBUSY ladder as _emit.mjs: on this box, renaming over or
// moving a file that a reader (the console, a concurrent list) holds open
// fails transiently; retry rather than losing the operation.
const RENAME_LADDER = [0, 5, 10, 20, 40, 80, 120, 200, 300, 400];

function renameWithRetry(from, to) {
  let lastErr;
  for (const delay of RENAME_LADDER) {
    if (delay) sleepSync(delay);
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      if (e.code !== "EPERM" && e.code !== "EACCES" && e.code !== "EBUSY") throw e;
      lastErr = e;
    }
  }
  throw lastErr;
}

// tmp + rename so a concurrent reader never observes a half-written message.
// Each message is a brand-new uniquely named file, so unlike index.json there
// is no shared read-modify-write and no lock is needed.
function writeJsonAtomic(path, obj) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
    renameWithRetry(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // Temp file never got created, or is already gone; the original error wins.
    }
    throw e;
  }
}

function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n - 3) + "...";
}

// --- argument parsing -----------------------------------------------------

const argv = process.argv.slice(2);
const positionals = [];
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--type" || a === "--text" || a === "--from" || a === "--session") {
    const v = argv[++i];
    if (v === undefined) fail(`missing value for ${a}`);
    flags[a.slice(2)] = v;
  } else if (a.startsWith("--")) {
    fail(`unknown flag ${a}\n${USAGE}`);
  } else {
    positionals.push(a);
  }
}

const [command, runId, filenameArg] = positionals;
if (!["write", "list", "reply"].includes(command)) fail(USAGE);
if (!runId) fail(USAGE);

// --- locate the store and the run -----------------------------------------

const storeRoot =
  process.env.ALBERT_STORE_ROOT || join(os.homedir(), ".claude", "agent-runs");

// Same contract as _emit.mjs: never write outside the run folder. A run-id
// must be a plain directory name; separators, '.', or '..' could escape the
// store via join().
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

const inboxDir = join(runDir, "inbox");
const processedDir = join(inboxDir, "processed");

// project = basename of the registered project_path, like _emit.mjs; needed
// for the chat.msg/chat.reply event lines.
function resolveProject() {
  let project = runId.replace(/-\d{4}-\d{2}-\d{2}(-.*)?$/, "");
  const indexPath = join(storeRoot, "index.json");
  if (existsSync(indexPath)) {
    try {
      const index = readJson(indexPath);
      const entry = Array.isArray(index?.runs) ? index.runs.find((r) => r && r.id === runId) : null;
      if (entry && typeof entry.project_path === "string" && entry.project_path.length > 0) {
        project = basename(entry.project_path.replace(/\\/g, "/"));
      }
    } catch {
      // Unreadable registry: the run-id-derived slug is good enough for an event line.
    }
  }
  return project;
}

function appendEvent(event) {
  appendFileSync(join(runDir, "events.jsonl"), JSON.stringify(event) + "\n", "utf8");
}

// --- commands -------------------------------------------------------------

if (command === "write") {
  const type = flags.type;
  const text = flags.text;
  if (!MSG_TYPES.includes(type)) fail(`--type must be one of ${MSG_TYPES.join("|")}, got: ${type}`);
  if (!text || !text.trim()) fail("--text is required and must be non-empty");
  const from = flags.from || "user";

  mkdirSync(inboxDir, { recursive: true });

  // <epoch_ms>-<pid>-<seq> sorts chronologically and cannot collide across
  // processes; the seq probe covers the same-pid-same-ms corner anyway.
  const epoch = Date.now();
  let seq = 1;
  let file;
  while (existsSync((file = join(inboxDir, `${epoch}-${process.pid}-${seq}.json`)))) seq++;

  const message = {
    id: `m-${epoch}-${process.pid}-${seq}`,
    ts: new Date(epoch).toISOString(),
    from,
    via: "chat",
    type,
    text,
  };
  if (flags.session) message.chat_session = flags.session;

  try {
    writeJsonAtomic(file, message);
  } catch (e) {
    fail(`cannot write inbox message: ${e.message}`);
  }

  try {
    appendEvent({
      ts: message.ts,
      run_id: runId,
      project: resolveProject(),
      type: "chat.msg",
      actor: from,
      target: "controller",
      summary: truncate(text, 200),
      data: { id: message.id, msg_type: type },
    });
  } catch (e) {
    fail(`message queued as ${basename(file)} but cannot append chat.msg event: ${e.message}`);
  }

  process.stdout.write(message.id + "\n");
  process.exit(0);
}

if (command === "list") {
  let names = [];
  try {
    names = readdirSync(inboxDir);
  } catch {
    // No inbox yet is the normal case.
    process.stdout.write("[]\n");
    process.exit(0);
  }
  const messages = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const path = join(inboxDir, name);
    try {
      if (!statSync(path).isFile()) continue;
      messages.push({ file: name, ...readJson(path) });
    } catch (e) {
      // A half-visible or corrupt file should not wedge the whole drain.
      process.stderr.write(`warning: skipping unreadable inbox file ${name}: ${e.message}\n`);
    }
  }
  process.stdout.write(JSON.stringify(messages, null, 2) + "\n");
  process.exit(0);
}

if (command === "reply") {
  const text = flags.text;
  if (!filenameArg) fail(USAGE);
  if (!text || !text.trim()) fail("--text is required and must be non-empty");
  // The filename comes back from `list`; hold it to the same no-escape rule as
  // run ids so a crafted value cannot reach outside the inbox.
  if (
    filenameArg === "." ||
    filenameArg === ".." ||
    !/^[A-Za-z0-9._-]+\.json$/.test(filenameArg)
  ) {
    fail(`invalid inbox filename: ${JSON.stringify(filenameArg)}`);
  }
  const file = join(inboxDir, filenameArg);
  if (!resolve(file).startsWith(resolve(inboxDir) + sep)) {
    fail(`filename resolves outside the inbox: ${JSON.stringify(filenameArg)}`);
  }

  let message;
  try {
    message = readJson(file);
  } catch (e) {
    fail(`cannot read inbox message ${filenameArg}: ${e.message}`);
  }

  // Event first, archive second: the reply must be durable before the message
  // stops being pending, or a crash here would drop it silently.
  const data = { reply_to: message.id, text };
  if (message.chat_session) data.chat_session = message.chat_session;
  try {
    appendEvent({
      ts: new Date().toISOString(),
      run_id: runId,
      project: resolveProject(),
      type: "chat.reply",
      actor: "controller",
      target: "user",
      summary: truncate(text, 200),
      data,
    });
  } catch (e) {
    fail(`cannot append chat.reply event: ${e.message}`);
  }

  try {
    mkdirSync(processedDir, { recursive: true });
    renameWithRetry(file, join(processedDir, filenameArg));
  } catch (e) {
    fail(`reply recorded but cannot archive ${filenameArg}: ${e.message} (it will be re-delivered next wake)`);
  }

  process.stdout.write((message.id || filenameArg) + "\n");
  process.exit(0);
}
