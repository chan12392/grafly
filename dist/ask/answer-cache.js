/**
 * Answer cache for `grafly ask` — `<contextDir>/.cache/answers.json`.
 *
 * Sessions repeat the same asks ("where is X called from", "how does Y
 * work"); each re-walks the graph and re-renders the same pack. This cache
 * replays the previous rendered answer verbatim when everything it depended
 * on is unchanged.
 *
 * Key = original query + the option bits that shape the answer (limit,
 * --source/--full, --in, graph-rank, --json) plus the effective Brain connection,
 * so differently-shaped asks of
 * the same words can never replay each other's output. Freshness = an
 * (mtimeMs, ctimeMs, inode, size) fingerprint over every file the answer covered — the source
 * files its hits point into plus the index files it was ranked from
 * (`indexDeps`) — so a rebuild or an edit anywhere invalidates even a
 * zero-hit answer that covered no source files.
 *
 * Everything here is fail-open: a missing, corrupt, or unwritable cache
 * behaves exactly like a cold one — the real ask runs and nothing breaks.
 */
import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CACHE_DIR } from "../context/node-file.js";
import { wiringPath } from "../graph/write.js";
import { xerjStatePath } from "../search/xerj.js";
import { normalizePathPrefix } from "../util/paths.js";
import { readJson, writeJsonAtomic, buildConfigPath, LEGACY_BUILD_CONFIG_DIR } from "../util/state.js";
import { rulesCachePath, readLink, brainIdentity } from "../brain/link.js";
import { askIndexPath } from "./index-file.js";
import { materialsPath } from "../materials/index.js";
/** Cap on stored answers per context dir — a session re-asks a handful of
 * questions; beyond this the oldest (`ts`) is evicted first. */
const MAX_ANSWERS = 30;
const CACHE_VERSION = 4;
/** Cache file for a context dir: `<dir>/.cache/answers.json` — the same
 * uncommitted local-cache location the ask sidecar already uses. */
function answersPath(ctxDir) {
    return join(ctxDir, CACHE_DIR, "answers.json");
}
function emptyCache() {
    return { version: CACHE_VERSION, entries: {} };
}
/** Read the answer cache, or an empty one on any problem — fail-open, so a
 * corrupt file costs a re-ask, never a broken one. */
export function loadAnswers(ctxDir) {
    try {
        const raw = readJson(answersPath(ctxDir));
        if (!raw || raw.version !== CACHE_VERSION || !raw.entries || typeof raw.entries !== "object")
            return emptyCache();
        return raw;
    }
    catch {
        return emptyCache();
    }
}
/** Persist the cache (atomic write via util/state.js, compact — only a
 * machine ever opens it). Fail-open: an unwritable cache is a missed
 * optimization, not an error. */
export function saveAnswers(ctxDir, cache) {
    try {
        writeJsonAtomic(answersPath(ctxDir), cache, true);
    }
    catch { /* fail-open */ }
}
/** The full cache key: the original query plus every option bit that
 * changes the rendered answer, so a `--source`/`--full`/`--limit`/`--in`/
 * `--no-graph-rank`/`--json` variant or Brain override gets its own entry. */
export function cacheKey(query, opts, repoDir) {
    return JSON.stringify([
        String(query ?? ""),
        Number(opts.limit),
        !!opts.source,
        !!opts.full,
        opts.in ? normalizePathPrefix(opts.in) : "",
        opts.graphRank !== false,
        opts.xerj !== false,
        !!opts.json,
        repoDir ? brainIdentity(readLink(repoDir)) : null,
    ]);
}
/** Freshness fingerprint: `{path: {m: mtimeMs, s: size}}` for each path that
 * stats cleanly. `p` may be repo-relative (resolved against `dir`) or
 * absolute (an index file under the context dir). Missing paths are stamped
 * too: creating the first Brain config/rules must invalidate an earlier answer. */
export function stampFiles(dir, relPaths) {
    const stamp = {};
    for (const p of relPaths) {
        try {
            const s = statSync(resolve(dir, p));
            stamp[p] = s.isFile() ? { m: s.mtimeMs, c: s.ctimeMs, i: s.ino, s: s.size } : null;
        }
        catch (error) {
            if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
            stamp[p] = null;
        }
    }
    return stamp;
}
/** The answer's graph, ask sidecar, concept cards, and Brain config/rules.
 * Both current and legacy config locations can supply the Brain link. Stamped
 * with covered source files so a rebuild — which rewrites wiring/ask-index — or a
 * card edit invalidates the replay even when every covered source file is
 * untouched (e.g. a "callers of X" answer after a NEW caller appeared in a
 * file the old answer never covered). */
export function indexDeps(ctxDir, repoDir = dirname(ctxDir)) {
    const deps = [wiringPath(ctxDir), askIndexPath(ctxDir), materialsPath(ctxDir), buildConfigPath(repoDir),
        join(repoDir, LEGACY_BUILD_CONFIG_DIR, 'config.json'), rulesCachePath(repoDir), xerjStatePath(ctxDir)];
    try {
        for (const entry of readdirSync(ctxDir))
            if (entry.endsWith(".md"))
                deps.push(join(ctxDir, entry));
    }
    catch { /* no readable context dir — the graph paths still stamp if they exist */ }
    return deps;
}
/** Fetch one entry. Undefined on miss. */
export function lookup(cache, key) {
    return cache?.entries?.[key];
}
/** True when every stamped file still has the exact (mtimeMs, size) it had
 * when the answer was stored. A touched, resized, or deleted file — or a
 * malformed entry — is stale: re-ask rather than replay. */
export function verify(dir, entry) {
    if (!entry || typeof entry.text !== "string" || !entry.stamp || typeof entry.stamp !== "object")
        return false;
    for (const [p, want] of Object.entries(entry.stamp)) {
        if (want !== null && !want)
            return false;
        let s;
        try {
            s = statSync(resolve(dir, p));
        }
        catch (error) {
            if (want === null && ['ENOENT', 'ENOTDIR'].includes(error.code)) continue;
            return false; // a covered file was deleted — the answer is stale
        }
        if (want === null) {
            if (!s.isFile()) continue;
            return false;
        }
        if (s.mtimeMs !== want.m || s.ctimeMs !== want.c || s.ino !== want.i || s.size !== want.s)
            return false;
    }
    return true;
}
/** Record an answer. `files` is the fingerprint map `stampFiles` returned;
 * entries carry `{text, stamp, ts}` and the cache is capped at MAX_ANSWERS
 * with the oldest `ts` evicted first. */
export function store(cache, key, { text, files }) {
    const entries = cache.entries ?? (cache.entries = {});
    entries[key] = { text, stamp: files, ts: Date.now() };
    const keys = Object.keys(entries);
    if (keys.length > MAX_ANSWERS) {
        // Insertion order survives the sort on equal ts (stable sort), so the
        // same-millisecond test/store burst still evicts the first written.
        keys.sort((a, b) => (entries[a].ts ?? 0) - (entries[b].ts ?? 0));
        for (const k of keys.slice(0, keys.length - MAX_ANSWERS))
            delete entries[k];
    }
    return cache;
}
