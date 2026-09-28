/**
 * Conditional read — "304 for context". A file already read in this session
 * must not be re-sent: identical content answers `unchanged @hash`, and a
 * changed file answers only the changed hunks (below a threshold), not the
 * whole file again. The runtime does all diffing — the model never expands a
 * hash; it only gets real text or a one-line freshness proof.
 *
 * State lives in `.grafly/.cache/session-reads.json` keyed by session id:
 * `{session: {path: {hash, snap}}}`. `snap` points at a content snapshot in
 * `.grafly/.cache/snaps/<hash>` kept so changed-line ranges can be located
 * after the working file moved on. Session id comes from
 * `.grafly/.cache/active-session`, written by the hooks on every prompt;
 * no session → no dedup (a "unchanged" answer would lie to a reader who
 * never saw the content).
 *
 * Everything is fail-open: any error anywhere falls back to a normal read.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SNAP_MAX_FILE = 256 * 1024; // don't snapshot files bigger than this
const SNAP_MAX_COUNT = 60;        // prune oldest snapshots beyond this
const DIFF_MAX_LINES = 2000;      // LCS is O(n·m) memory too; above this just re-read
const DIFF_CHANGE_RATIO = 0.4;    // hunks worth it only under this change share
const HUNK_CONTEXT = 2;

const sha1 = (s) => createHash("sha1").update(s).digest("hex").slice(0, 10);
const split = (t) => t.split("\n");

/** Nearest enclosing `.grafly` dir walking up from `p`, or null. */
function contextDirFor(p) {
    let dir = p;
    try { if (statSync(dir).isFile()) dir = join(dir, ".."); } catch { return null; }
    for (let i = 0; i < 40; i++) {
        const g = join(dir, ".grafly");
        if (existsSync(g)) return g;
        const up = join(dir, "..");
        if (up === dir) return null;
        dir = up;
    }
    return null;
}

function loadState(ctxDir) {
    try { return JSON.parse(readFileSync(join(ctxDir, ".cache", "session-reads.json"), "utf8")); }
    catch { return {}; }
}

function saveState(ctxDir, state) {
    try {
        const dir = join(ctxDir, ".cache");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "session-reads.json"), JSON.stringify(state));
    }
    catch { /* fail-open */ }
}

function sessionId(ctxDir) {
    // Env override first — hosts that know their session id can export it, and
    // tests isolate from whatever active-session a real session last wrote.
    const env = process.env.GRAFLY_SESSION_ID;
    if (env) return env.trim() || null;
    try {
        const id = readFileSync(join(ctxDir, ".cache", "active-session"), "utf8").trim();
        return id || null;
    }
    catch { return null; }
}

function snapPath(ctxDir, hash) { return join(ctxDir, ".cache", "snaps", hash); }

function writeSnap(ctxDir, hash, text) {
    try {
        if (text.length > SNAP_MAX_FILE) return null;
        const dir = join(ctxDir, ".cache", "snaps");
        mkdirSync(dir, { recursive: true });
        const p = snapPath(ctxDir, hash);
        if (!existsSync(p)) writeFileSync(p, text);
        return p;
    }
    catch { return null; }
}

/** Longest-common-subsequence diff over line arrays → changed ranges on `cur`. */
function changedRanges(prev, cur) {
    const n = prev.length, m = cur.length;
    if (n > DIFF_MAX_LINES || m > DIFF_MAX_LINES) return null;
    // Trim common prefix/suffix — the LCS runs on the middle only.
    let lo = 0, hi = 0;
    while (lo < n - hi && lo < m - hi && prev[lo] === cur[lo]) lo++;
    while (hi < n - lo && hi < m - lo && prev[n - 1 - hi] === cur[m - 1 - hi]) hi++;
    const a = prev.slice(lo, n - hi), b = cur.slice(lo, m - hi);
    const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--)
        for (let j = b.length - 1; j >= 0; j--)
            dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const ranges = [];
    let i = 0, j = 0, start = -1;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            if (start >= 0) { ranges.push([start, lo + j - 1]); start = -1; }
            i++; j++;
        }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { if (start < 0) start = lo + j; i++; }
        else { if (start < 0) start = lo + j; j++; }
    }
    // Any unmatched tail (inserted in cur, deleted from prev) is one last hunk.
    if (start >= 0 || j < b.length || i < a.length)
        ranges.push([start >= 0 ? start : Math.max(0, lo + j - 1), m - hi - 1]);
    return ranges.filter(([s, e]) => e >= s);
}

function hunkOutput(full, cur, ranges, oldHash, newHash) {
    const out = [`[grafly read ${full}: changed since @${oldHash} → @${newHash}; ${ranges.length} hunk(s); unchanged lines elided; force full: grafly read "${full}" --fresh]\n`];
    for (const [s, e] of ranges) {
        const from = Math.max(0, s - HUNK_CONTEXT), to = Math.min(cur.length - 1, e + HUNK_CONTEXT);
        for (let i = from; i <= to; i++) out.push(`${i + 1}: ${cur[i]}\n`);
        out.push("  ⋮\n");
    }
    return out.join("");
}

/**
 * Conditional variant of a plain file read. Returns a string to serve INSTEAD
 * of the normal read when a hit applies, or null for "do a normal read".
 * Records the read + snapshot on the miss path the caller returns.
 */
export function conditionalRead(full, text, { fresh = false, whole = true } = {}) {
    try {
        // Dedup claims "you already have this content" — only true when the
        // earlier read was a whole-file read and this request is too. A --fresh
        // read still re-records: the caller now holds this exact content.
        if (!whole) return { replay: null, record: null };
        const ctxDir = contextDirFor(full);
        if (!ctxDir) return { replay: null, record: null };
        const session = sessionId(ctxDir);
        if (!session) return { replay: null, record: null };
        const hash = sha1(text);
        const state = loadState(ctxDir);
        const prior = state[session]?.[full];
        const snap = writeSnap(ctxDir, hash, text);
        const record = { path: full, hash, snap };
        if (fresh) return { replay: null, record, ctxDir, session };
        if (prior?.hash === hash)
            return { replay: `[grafly read ${full}: unchanged since your previous read @${hash} — ${split(text).length} lines, ${text.length} bytes already in context; force full: grafly read "${full}" --fresh]\n`, record, ctxDir, session };
        if (prior?.snap && existsSync(prior.snap)) {
            const ranges = changedRanges(split(readFileSync(prior.snap, "utf8")), split(text));
            if (ranges) {
                const changed = ranges.reduce((a, [s, e]) => a + e - s + 1, 0);
                if (ranges.length && changed / Math.max(split(text).length, 1) < DIFF_CHANGE_RATIO)
                    return { replay: hunkOutput(full, split(text), ranges, prior.hash, hash), record, ctxDir, session };
            }
        }
        return { replay: null, record, ctxDir, session };
    }
    catch { return { replay: null, record: null }; }
}

/**
 * PreToolUse gate for native read tools: deny only a REPEAT read of a file
 * this session already holds — first reads always pass (blocking them costs a
 * round trip and saves nothing). The denial reason carries the answer: either
 * "unchanged, you have it" or "changed — grafly read serves just the hunks".
 * A once-per-session journal lets an insistent read through on retry so the
 * gate can never loop a caller.
 *
 * A first read also RECORDS itself (pre-tool knows the content already) so the
 * next native read can be gated — closing the "native read twice" hole. Edge:
 * if the host's approval flow vetoes the read after we stamp it, the record
 * says "seen" when it wasn't — the deny reason offers `--fresh` and the
 * once-journal lets a retry through, so it self-heals.
 *
 * `whole`: false when the request carries a range (offset/limit etc.) — a
 * partial read must not claim whole-file knowledge.
 *
 * Returns { deny: true, reason } | { deny: false }. Fail-open throughout.
 */
export function gateNativeRead(full, { whole = true } = {}) {
    try {
        const ctxDir = contextDirFor(full);
        if (!ctxDir) return { deny: false };
        const session = sessionId(ctxDir);
        if (!session) return { deny: false };
        const stat = statSync(full);
        if (!stat.isFile() || stat.size > SNAP_MAX_FILE) return { deny: false };
        const text = readFileSync(full, 'utf8');
        if (text.includes('\0')) return { deny: false };
        const hash = sha1(text);
        const state = loadState(ctxDir);
        const prior = state[session]?.[full];
        if (!prior?.hash) {
            if (whole) {
                const snap = writeSnap(ctxDir, hash, text);
                const files = state[session] ?? (state[session] = {});
                files[full] = { hash, snap };
                saveState(ctxDir, state);
            }
            return { deny: false };
        }
        const reason = hash === prior.hash
            ? `unchanged since your earlier read @${hash} — the content is already in context; to force a full re-read run: grafly read "${full}" --fresh`
            : `changed since your earlier read @${prior.hash} — run \`grafly read "${full}"\` for only the changed hunks, or call this read tool again to force a full re-read`;
        // Loop guard: a second native read of the same path this session is the
        // caller asserting it really wants the full body — let it through.
        const journalPath = join(ctxDir, '.cache', 'read-gate-denied.json');
        let journal = {};
        try { journal = JSON.parse(readFileSync(journalPath, 'utf8')) ?? {}; } catch { /* fresh journal */ }
        const denied = journal[session] ?? [];
        if (denied.includes(full)) return { deny: false };
        journal[session] = [...denied, full];
        try { writeFileSync(journalPath, JSON.stringify(journal)); } catch { /* fail-open */ }
        return { deny: true, reason };
    }
    catch { return { deny: false }; }
}

/** Persist a read record after the (normal or replayed) response is served. */
export function commitRead(result) {
    try {
        if (!result?.record || !result.ctxDir || !result.session) return;
        const state = loadState(result.ctxDir);
        const files = state[result.session] ?? (state[result.session] = {});
        files[result.record.path] = { hash: result.record.hash, snap: result.record.snap };
        const keys = Object.keys(files);
        if (keys.length > SNAP_MAX_COUNT)
            for (const k of keys.slice(0, keys.length - SNAP_MAX_COUNT)) delete files[k];
        saveState(result.ctxDir, state);
    }
    catch { /* fail-open */ }
}
