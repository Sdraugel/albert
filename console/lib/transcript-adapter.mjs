// Transcript adapter: the ONLY module that knows Claude Code's jsonl schema.
//
// ============================ PRIVACY CONTRACT ============================
// Transcripts contain FULL user prompts and FULL tool output across every
// project on this box, including repos whose own rules forbid reading .env
// because it holds live secrets. This module is the boundary that makes the
// dashboard STRUCTURALLY INCAPABLE of rendering any of it.
//
// RULES (a reviewer will grep for violations):
//   1. Every returned object is built from NAMED fields, literal by literal.
//      NEVER spread, Object.assign, JSON round-trip, or otherwise bulk-copy a
//      parsed transcript object into an output. If you cannot name it, it does
//      not leave. This file contains NO spread operator at all, so a grep for
//      `...` returning nothing is a valid check rather than a list of
//      benign-looking hits a reviewer has to adjudicate one by one.
//   2. NEVER pass through, at any nesting depth:
//        prompt, content, message.content bodies, text, last_assistant_message,
//        toolUseResult.content, tool_use.input beyond the allowlist below,
//        attachment bodies, file contents, command strings, queries, diffs.
//   3. ALLOWLIST - the complete set of fields permitted to leave this module:
//        envelope : sessionId, cwd, gitBranch, entrypoint, timestamp, type,
//                   isSidechain
//        title    : aiTitle
//        tool_use : name, id
//        input    : subagent_type, description (TRUNCATED to 120 chars; a
//                   model-authored 3-5 word label, the ONLY free text allowed)
//        result   : status, agentId, agentType, resolvedModel, totalDurationMs,
//                   totalTokens, totalToolUseCount
//        message  : model, usage token counts (numbers only)
//      Tool NAMES may leave. Tool INPUTS may not - not even Bash commands, which
//      is why the compliance "tests" signal counts Bash calls by name only and
//      is a documented proxy rather than a real test-run count.
//   4. parseLine NEVER throws. An unrecognized or renamed shape degrades to
//      kind:'other' - it must never crash the tailer or leak on a fallback path.
//
// The schema is internal to Claude Code and HAS ALREADY DRIFTED (the dispatch
// tool is named "Agent" in transcripts while hook matchers still say "Task";
// an `effort` input key appeared that no spec mentioned). Both names are
// accepted; unknown keys are ignored by construction, never forwarded.
// =========================================================================
//
// VERIFIED against 71 top-level transcripts / 56,620 lines on this box:
//   - entrypoint: only "claude-vscode" observed. Any other/absent value maps to
//     "unknown". No CLI literal is hardcoded - a CLI session has never run here,
//     so its entrypoint string is UNKNOWN and must not be invented.
//   - types seen: assistant, user, last-prompt, ai-title, attachment,
//     queue-operation, file-history-snapshot, pr-link, mode, file-history-delta,
//     system. (`pr-link` and `system` were absent from the written spec - proof
//     that the tolerate-unknown rule earns its keep.)
//
// DELIBERATE DEVIATIONS from the written spec, with evidence:
//
//   (a) parseLine returns `toolCalls[]` / `dispatches[]` ARRAYS rather than a
//       single flattened tool_use per record. One assistant line legitimately
//       carries several tool_use blocks; a scalar shape would undercount a turn
//       that fires two Greps. Counts must be right, so arrays it is.
//
//   (b) 'user-turn' means a HUMAN turn, not literally `type === 'user'`.
//       Measured: of 13,313 user lines, 12,059 (91%) are tool_result deliveries
//       and 114 are isMeta system injections; only 1,140 are human turns.
//       Counting the literal way inflates `turns` ~12x and makes the column
//       meaningless, so tool_result and isMeta lines classify as 'other'.

const MAX_DESCRIPTION = 120;

/** Truncate model-authored labels. The only free text this module may emit. */
function safeLabel(value, max = MAX_DESCRIPTION) {
  if (typeof value !== 'string') return null;
  const flat = value.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function safeString(value) {
  return typeof value === 'string' && value ? value : null;
}

function safeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Strip a UTF-8 BOM; JSON.parse rejects it and files on this box carry one. */
function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Surface label. Derived, never invented: only "claude-vscode" has been observed
 * on this box, so everything else is honestly "unknown" rather than guessed CLI.
 */
export function toSurface(entrypoint) {
  return entrypoint === 'claude-vscode' ? 'claude-vscode' : 'unknown';
}

/**
 * The envelope, extracted field by named field. This is the ONLY object
 * construction path for a record: every `parseLine` return value starts here and
 * then has allowlisted properties assigned onto it by name.
 */
function baseRecord(o) {
  return {
    kind: 'other',
    type: safeString(o.type),
    sessionId: safeString(o.sessionId),
    cwd: safeString(o.cwd),
    gitBranch: safeString(o.gitBranch),
    entrypoint: safeString(o.entrypoint),
    timestamp: safeString(o.timestamp),
    isSidechain: o.isSidechain === true,
  };
}

/** Named-field extraction of message.usage. Numbers only, never text. */
function extractUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const out = {
    input_tokens: safeNumber(usage.input_tokens),
    output_tokens: safeNumber(usage.output_tokens),
    cache_read_input_tokens: safeNumber(usage.cache_read_input_tokens),
    cache_creation_input_tokens: safeNumber(usage.cache_creation_input_tokens),
  };
  const hasAny = Object.values(out).some((v) => v !== null);
  return hasAny ? out : null;
}

/**
 * A dispatch result (`toolUseResult` on a user line). Built field by field.
 * `toolUseResult.content` - the subagent's full report - is deliberately absent.
 *
 * Stands alone by design: 282 results were measured against 279 dispatch lines,
 * so 3 results have no dispatch in any live file (resumed or pruned session).
 * The result therefore carries its own agentType and never relies on correlation.
 */
function extractResult(result, toolUseId) {
  return {
    toolUseId: safeString(toolUseId),
    agentId: safeString(result.agentId),
    agentType: safeString(result.agentType),
    status: safeString(result.status),
    resolvedModel: safeString(result.resolvedModel),
    totalDurationMs: safeNumber(result.totalDurationMs),
    totalTokens: safeNumber(result.totalTokens),
    totalToolUseCount: safeNumber(result.totalToolUseCount),
  };
}

/** Assistant line: tool_use blocks -> dispatch + tool-call records. */
function parseAssistant(o, rec) {
  rec.model = safeString(o.message?.model);
  rec.usage = extractUsage(o.message?.usage);
  rec.dispatches = [];
  rec.toolCalls = [];

  const content = o.message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type !== 'tool_use') continue; // text/thinking blocks: dropped
      const toolName = safeString(block.name);
      if (!toolName) continue;
      // Tool NAME only. block.input is never forwarded except the two
      // allowlisted dispatch keys below.
      rec.toolCalls.push({ toolName });
      // Accept BOTH names: transcripts say "Agent", hooks still say "Task".
      if (toolName === 'Agent' || toolName === 'Task') {
        rec.dispatches.push({
          toolUseId: safeString(block.id),
          subagentType: safeString(block.input?.subagent_type),
          description: safeLabel(block.input?.description),
          // input.prompt is the full task text: NEVER read, NEVER emitted.
        });
      }
    }
  }

  if (rec.dispatches.length > 0) rec.kind = 'dispatch';
  else if (rec.toolCalls.length > 0) rec.kind = 'tool-call';
  else rec.kind = 'meta';
  return rec;
}

/** User line: dispatch result, tool result, or a real human turn. */
function parseUser(o, rec) {
  const content = o.message?.content;
  let toolUseId = null;
  let hasToolResult = false;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_result') {
        hasToolResult = true;
        if (!toolUseId) toolUseId = safeString(block.tool_use_id);
        // block.content is the full tool output: never touched.
      }
    }
  }

  const r = o.toolUseResult;
  const isAgentResult =
    r && typeof r === 'object' && !Array.isArray(r) && safeString(r.agentId);
  if (isAgentResult) {
    rec.kind = 'dispatch-result';
    rec.result = extractResult(r, toolUseId);
    return rec;
  }

  // See deviation (b): tool_result deliveries and isMeta injections are not
  // human turns. 91% of user lines are one of these.
  if (hasToolResult || o.isMeta === true) return rec;

  rec.kind = 'user-turn';
  return rec;
}

/**
 * Parse one jsonl line into a safe, structured record.
 * Returns null for blank/unparseable lines. NEVER throws.
 *
 * kinds: 'meta' | 'user-turn' | 'title' | 'dispatch' | 'dispatch-result'
 *        | 'tool-call' | 'other'
 *
 * Every record carries the envelope (sessionId, cwd, gitBranch, entrypoint,
 * timestamp, isSidechain) so the tailer never needs the raw object.
 */
export function parseLine(rawLine) {
  try {
    if (typeof rawLine !== 'string') return null;
    const trimmed = stripBom(rawLine).replace(/\r$/, '').trim();
    if (!trimmed || trimmed[0] !== '{') return null;

    let o;
    try {
      o = JSON.parse(trimmed);
    } catch {
      return null; // partial or malformed line: ignore, never throw
    }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;

    const rec = baseRecord(o);

    if (rec.type === 'ai-title') {
      const aiTitle = safeLabel(o.aiTitle, MAX_DESCRIPTION);
      if (aiTitle) {
        rec.kind = 'title';
        rec.aiTitle = aiTitle;
      }
      return rec;
    }
    if (rec.type === 'assistant') return parseAssistant(o, rec);
    if (rec.type === 'user') return parseUser(o, rec);

    // Everything else (attachment, last-prompt, pr-link, system, mode, ...):
    // envelope only. Unknown future types land here rather than throwing.
    return rec;
  } catch {
    return null; // hard guarantee: parseLine never throws
  }
}

/**
 * Fidelity check over sample lines. Verifies the adapter still recognizes the
 * live schema; a dispatch count of 0 across a busy transcript is the canary for
 * another rename of Agent/Task.
 */
export function adapterSelfTest(sampleLines) {
  const notes = [];
  const counts = Object.create(null);
  let parsed = 0;
  let unparseable = 0;
  let dispatches = 0;

  const lines = Array.isArray(sampleLines) ? sampleLines : [];
  for (const line of lines) {
    if (typeof line !== 'string' || !line.trim()) continue;
    const rec = parseLine(line);
    if (!rec) {
      unparseable++;
      continue;
    }
    parsed++;
    counts[rec.kind] = (counts[rec.kind] || 0) + 1;
    if (rec.kind === 'dispatch') dispatches += rec.dispatches.length;
  }

  if (parsed === 0) notes.push('no lines parsed: sample empty or schema changed wholesale');
  if (parsed > 0 && !counts['user-turn']) notes.push('no human turns detected in sample');
  if (parsed > 0 && !counts['tool-call'] && !counts.dispatch) {
    notes.push('no tool_use blocks recognized: tool_use shape may have drifted');
  }

  return {
    ok: unparseable === 0 && parsed > 0,
    parsed,
    dispatches,
    unparseable,
    kinds: counts,
    notes,
  };
}
