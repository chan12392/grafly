/**
 * Session usage accounting, shared across every host (Claude Code and Cursor).
 * It answers the one question the README rests on: when an agent had
 * both graft and grep in front of it, which did it reach for, and how much did
 * that save?
 *
 * The counters (`graftReads`, `sourceReads`, `savedTokens`) already live on
 * {@link SessionState}; before this module nothing ever incremented the first
 * two, so `session_summary` telemetry shipped 0/0 for every session. Everything
 * here is a pure classify + read-modify-write over `graft/.cache/session/`, so a
 * host adapter is a few lines: parse its payload, call {@link recordToolUse}.
 *
 * Two payload shapes feed it, confirmed against the vendor docs rather than
 * guessed (the matcher depends on getting the names right):
 *
 *   - Claude Code `PostToolUse`  — `{ tool_name, tool_input: { command }, tool_response }`.
 *     A graft retrieval prints a `[graft] tokens saved ≈ N` footer into
 *     `tool_response`, which is itself proof graft ran.
 *   - Cursor `postToolUse`       — `{ tool_name, tool_input, tool_output, conversation_id }`
 *     (https://cursor.com/docs/hooks). `tool_output` is the JSON-stringified
 *     result; a Shell `graft …` call carries the same footer inside its stdout.
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { sumSavingsFooters } from '../context/savings.js';
import { dollarsSaved, formatDollars } from '../context/price.js';
import { readSession, writeSession, sessionDir, listSessionIds } from './state.js';
/** Native tools that mean "the agent went to read source itself" — the grep/read
 *  path graft is meant to replace. These are the host tool NAMES (Claude Code and
 *  Cursor both use Read/Grep/Glob; Cursor adds Search); shell builtins like `ls`
 *  are commands, never tool names, so they belong to the Shell branch, not here.
 *  Compared lower-cased. */
const SOURCE_TOOLS = new Set(['read', 'grep', 'glob', 'search']);
/** The host's shell tool, whose `command` we then inspect for a graft invocation. */
function isShellTool(t) {
    return t === 'bash' || t === 'shell';
}
/** Whether a shell command line invokes the graft CLI (any of its install shapes). */
export function commandInvokesGraft(command) {
    const c = command.trim();
    if (/dist[/\\]cli\.js/.test(c))
        return true; // running from a source checkout
    // `graft …`, `graft-dev …`, `npx [-y] [@nanonets/]graft …`, at the start of the
    // line or of a &&/;/| segment — not "mygraft" or a path that merely contains it.
    return /(^|[|&;]\s*)(?:grafly\b|(?:npx\s+(-y\s+)?(@nanonets\/)?)?graft(-dev)?\b)/i.test(c);
}
/**
 * Classify one tool use as a graft retrieval, a source read, or neither
 * (an edit, a task spawn, an unrelated shell command — no retrieval signal).
 * `command` is the shell command line when `toolName` is the host's shell tool.
 */
export function classifyToolUse(toolName, command) {
    const t = (toolName ?? '').toLowerCase();
    if (!t)
        return null;
    if (SOURCE_TOOLS.has(t))
        return 'source';
    if (isShellTool(t) && command && commandInvokesGraft(command))
        return 'graft';
    return null;
}
/** Sum every `[graft] tokens saved ≈ N` footer in a blob of tool output. Thin
 *  alias over {@link sumSavingsFooters}, which lives next to the code that writes
 *  the footer so the two can't drift. */
export function parseSavings(blob) {
    return sumSavingsFooters(blob);
}
/**
 * Fold one tool use into a session's counters. A no-op when there is nothing to
 * record (kind null and no savings), so a host can call it unconditionally after
 * every tool without first checking whether the tool was interesting — the
 * no-write path is what keeps it cheap on the Write/Edit/Task majority.
 *
 * Best-effort read-modify-write, not locked — mirroring `patchStats` in
 * util/state.ts. Two tool-use hooks racing on the same session file can lose a
 * count; that is acceptable for an episodic usage estimate (worst case is an
 * undercount by one, never corruption thanks to the atomic write), and a lock
 * here would contend with the build lock these hooks also touch.
 */
export function recordToolUse(dir, sessionId, use) {
    const saved = use.savedTokens ?? 0;
    if (!use.kind && saved <= 0)
        return;
    const id = sessionId || 'default';
    const s = readSession(dir, id);
    if (use.kind === 'graft')
        s.graftReads = (s.graftReads ?? 0) + 1;
    else if (use.kind === 'source')
        s.sourceReads = (s.sourceReads ?? 0) + 1;
    if (saved > 0)
        s.savedTokens = (s.savedTokens ?? 0) + saved;
    // A graft use owes a tally in this turn's reply; the Stop hook (countTallyTurn)
    // resolves whether it got one and clears the flag. A flag, not a count — a turn
    // with several graft calls is still one reply to the user.
    if (use.kind === 'graft')
        s.turnUsedGraft = true;
    // Stamp the host once; the first tool use that lands owns the attribution.
    if (use.host && !s.host)
        s.host = use.host;
    writeSession(dir, id, s);
}
/** The most-recently-touched session file for a repo, or null when none exist —
 *  what `graft stats` shows by default: the session you were just in. */
export function latestSession(dir) {
    const sdir = sessionDir(dir);
    let bestId = null;
    let bestMtime = -Infinity;
    for (const id of listSessionIds(dir)) {
        let mtime;
        try {
            mtime = statSync(join(sdir, `${id}.json`)).mtimeMs;
        }
        catch {
            continue;
        }
        if (mtime > bestMtime) {
            bestMtime = mtime;
            bestId = id;
        }
    }
    if (bestId === null)
        return null;
    return { id: bestId, ...readSession(dir, bestId) };
}
/**
 * A one-line-per-fact readout of a session's usage mix — Cursor has no
 * statusline, so this is how you see the numbers the Claude Code bar would show.
 * Reads local JSON only; sends nothing.
 */
/**
 * What this repo's most recent session has actually been paying per million
 * input tokens, or null when no turn has been billed yet.
 *
 * `latestSession` rather than a session id because the callers are CLI
 * invocations answering one query: they know the repo, never the host's session
 * id. The rate belongs to the repo's current session, which is the one whose
 * reply the number is about to appear in.
 */
export function sessionInputRate(dir) {
    const s = latestSession(dir);
    if (!s?.inputCostMicros || !s?.inputTokensBilled)
        return null;
    // Micro-dollars per token and dollars per million tokens are the same number:
    // both divide by 1e6 once. Returned as $/Mtok because that is the unit the
    // price table is written in and the one a reader can sanity-check against it.
    return s.inputCostMicros / s.inputTokensBilled;
}
export function formatSessionStats(s) {
    if (s === null) {
        return 'grafly stats: no session recorded yet — use grafly in an agent session, then look again.';
    }
    const graft = s.graftReads ?? 0;
    const source = s.sourceReads ?? 0;
    const saved = s.savedTokens ?? 0;
    const total = graft + source;
    const mix = total === 0 ? 'no retrieval yet' : `${Math.round((graft / total) * 100)}% grafly`;
    const lines = [
        `grafly stats — session ${s.id}`,
        `  grafly reads:  ${graft}`,
        `  source reads:  ${source}   (Read / Grep / Glob)`,
        `  mix:           ${mix}`,
        `  tokens saved:  ~${saved.toLocaleString()}`,
    ];
    // Omitted, not zeroed, when no turn has been billed yet: a host whose hooks
    // name no transcript can't know what a token costs here, and a made-up rate
    // would be worse than the silence.
    const usd = dollarsSaved(saved, s.inputCostMicros, s.inputTokensBilled);
    if (usd !== null)
        lines.push(`  value saved:   ~${formatDollars(usd)}`);
    if (s.lastQuery)
        lines.push(`  last query:    ${s.lastQuery}`);
    return lines.join('\n');
}
