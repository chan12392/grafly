/** Hash-only receipts for complete Grafly reads; never store file contents.
 * Missing identity, stale receipts and cache errors return real content.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { hasGraflyIndex } from "../graph/root.js";
import { contextDirFor as indexDir } from "../context/node-file.js";
import { acquireLockIn, releaseLockIn, readJson, writeJsonAtomic } from "../util/state.js";

const MAX_SESSIONS = 32, MAX_FILES = 60, MAX_AGE_MS = 24 * 60 * 60 * 1000;
const NATIVE_MAX_CHARS = 20000;
const hashText = text => createHash("sha256").update(text).digest("hex");

function contextDirFor(full) {
    let dir = dirname(realpathSync(full));
    const home = realpathSync(homedir());
    for (;;) {
        // Global state must never become a repository cache.
        if (dir === home) return null;
        if (hasGraflyIndex(dir)) return indexDir(dir);
        const up = dirname(dir);
        if (up === dir || existsSync(join(dir, ".git"))) return null;
        dir = up;
    }
}

function sessionId(explicit = process.env.GRAFLY_SESSION_ID) {
    return typeof explicit === "string" ? explicit.trim() || null : null;
}

function statePath(ctxDir) { return join(ctxDir, ".cache", "session-reads.json"); }

function loadState(ctxDir) {
    const raw = readJson(statePath(ctxDir));
    // Legacy pre-tool stamps did not prove content delivery.
    const sessions = raw?.version === 2 ? raw.sessions : null;
    const now = Date.now();
    return Object.fromEntries(Object.entries(sessions ?? {})
        .filter(([, s]) => s && Number.isFinite(s.ts) && now - s.ts < MAX_AGE_MS && s.files)
        .sort((a, b) => b[1].ts - a[1].ts).slice(0, MAX_SESSIONS)
        .map(([id, s]) => [id, { ts: s.ts, files: Object.fromEntries(Object.entries(s.files)
            .filter(([, f]) => f && typeof f.hash === "string" && Number.isFinite(f.ts) && now - f.ts < MAX_AGE_MS)
            .sort((a, b) => b[1].ts - a[1].ts).slice(0, MAX_FILES)) }]));
}

/** Serialize updates; contention skips caching rather than blocking a read. */
function updateState(ctxDir, update) {
    const lockDir = join(ctxDir, ".cache", "read-state");
    if (!acquireLockIn(lockDir)) return false;
    try {
        const state = loadState(ctxDir);
        if (!update(state)) return false;
        const sessions = Object.fromEntries(Object.entries(state)
            .sort((a, b) => b[1].ts - a[1].ts).slice(0, MAX_SESSIONS));
        writeJsonAtomic(statePath(ctxDir), { version: 2, sessions }, true);
        return true;
    } finally { releaseLockIn(lockDir); }
}

export function conditionalRead(full, text, { fresh = false, whole = true, sessionId: identity } = {}) {
    try {
        const session = sessionId(identity);
        if (!whole || !session) return { replay: null, record: null };
        const ctxDir = contextDirFor(full);
        if (!ctxDir) return { replay: null, record: null };
        const hash = hashText(text);
        const prior = loadState(ctxDir)[session]?.files[full];
        const replay = !fresh && prior?.hash === hash
            ? `[grafly read ${full}: unchanged since your previous read @${hash.slice(0, 12)} — ${text.split("\n").length} lines, ${Buffer.byteLength(text)} bytes already in context; force full: grafly read "${full}" --fresh]\n`
            : null;
        return { replay, record: { path: full, hash }, ctxDir, session };
    } catch { return { replay: null, record: null }; }
}

/** Devin's default read is bounded to 20,000 characters. Pre-tool attempts
 * cannot prove delivery. Only a prior complete Grafly read can deny an
 * unchanged read, once per receipt; changes and explicit ranges pass through.
 */
export function gateNativeRead(full, { whole = true, sessionId: identity } = {}) {
    try {
        const session = sessionId(identity);
        if (!whole || !session) return { deny: false };
        const stat = statSync(full);
        if (!stat.isFile() || stat.size > NATIVE_MAX_CHARS) return { deny: false };
        const ctxDir = contextDirFor(full);
        if (!ctxDir) return { deny: false };
        const text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(full));
        if (text.includes("\0") || text.length > NATIVE_MAX_CHARS) return { deny: false };
        const hash = hashText(text);
        const denied = updateState(ctxDir, state => {
            const prior = state[session]?.files[full];
            if (prior?.hash !== hash || prior.denied) return false;
            prior.denied = true;
            return true;
        });
        return denied ? { deny: true, reason: `unchanged since your earlier read @${hash.slice(0, 12)} — the content is already in context; to force a full re-read run: grafly read "${full}" --fresh` } : { deny: false };
    } catch { return { deny: false }; }
}

/** Persist only after the caller has produced a complete response. */
export function commitRead(result) {
    try {
        if (!result?.record || !result.ctxDir || !result.session) return;
        updateState(result.ctxDir, state => {
            const { path, hash } = result.record;
            const prior = state[result.session]?.files[path];
            const files = { ...state[result.session]?.files };
            delete files[path];
            const ts = Date.now();
            state[result.session] = { ts, files: { [path]: { hash, ts, denied: prior?.hash === hash && prior.denied === true },
                ...Object.fromEntries(Object.entries(files).slice(0, MAX_FILES - 1)) } };
            return true;
        });
    } catch { /* cache failure must never prevent a read */ }
}
