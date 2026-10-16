/**
 * mtime-keyed in-process cache over the two readers `ask()` calls on every
 * query: the wiring graph (`readGraph`) and the ask sidecar (`readAskIndex`).
 * `graft ask` re-parses these from disk on every invocation; in a long-lived
 * process — a workspace command, or `graft ask` invoked repeatedly in one
 * process — that means re-parsing the same ~tens-of-MB JSON on every call.
 *
 * Keyed by `(path, mtimeMs, ctimeMs, inode, size)` from `statSync`, so a rebuild (`graft
 * build`) is picked up on the very next call with no polling and no TTL: the
 * stat is cheap relative to the parse it guards, and a changed mtime or size
 * invalidates the entry. A missing file returns null and is never cached — the
 * next call re-stats, so a file created after a prior miss is picked up
 * immediately (no negative caching).
 *
 * ctime and inode also detect same-size replacements whose mtime is restored
 * by checkout/sync tools. In-process rebuilds still invalidate explicitly.
 *
 * Dependency-free by design: this module imports only `node:fs`, `./write.js`,
 * and `../ask/index-file.js`, so it can be imported from `ask.ts`, the CLI
 * surfaces, and `workspace.js` without creating an import cycle.
 */
import { statSync } from "node:fs";
import { readGraph, wiringPath, traversePath } from "./write.js";
import { readAskIndex, askIndexPath } from "../ask/index-file.js";
const graphCache = new Map();
const askIndexCache = new Map();
const traverseCache = new Map();
/** Real parses performed (cache misses), not cache hits — exported for tests
 * so the invalidation contract can be pinned down without spying on `fs`. */
export const __parseCount = { graph: 0, askIndex: 0, traverse: 0 };
/** Test-only: zero the counters (module state persists across a test file). */
export function __resetParseCounts() {
    __parseCount.graph = 0;
    __parseCount.askIndex = 0;
    __parseCount.traverse = 0;
}
function statOf(path) {
    try {
        const s = statSync(path);
        return { mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, ino: s.ino, size: s.size };
    }
    catch {
        return null;
    }
}
function loadCached(cache, path, parse, onParse) {
    const st = statOf(path);
    if (!st) {
        // Missing file: don't negatively cache, and drop any stale entry so a
        // subsequently-created file at the same path is re-parsed, not served
        // from a cache keyed to the old (mtime, size).
        cache.delete(path);
        return null;
    }
    const cached = cache.get(path);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.ctimeMs === st.ctimeMs && cached.ino === st.ino && cached.size === st.size) {
        return cached.value;
    }
    onParse();
    const value = parse();
    cache.set(path, { ...st, value });
    return value;
}
/** Cached `readGraph(wiringPath(outDir))` — same null-on-missing/unparseable
 * semantics, re-reads only when the wiring file's `(mtimeMs, size)` changed.
 * Returns a shared cached reference; callers must not mutate the returned graph. */
export function loadGraphCached(outDir) {
    const path = wiringPath(outDir);
    return loadCached(graphCache, path, () => readGraph(path), () => {
        __parseCount.graph++;
    });
}
/** Cached `readAskIndex(outDir)` — same semantics, keyed on the sidecar file.
 * Returns a shared cached reference; callers must not mutate the returned index. */
export function loadAskIndexCached(outDir) {
    const path = askIndexPath(outDir);
    return loadCached(askIndexCache, path, () => readAskIndex(outDir), () => {
        __parseCount.askIndex++;
    });
}
/**
 * Slim traversal graph for callers/grep/trace: `wiring-traverse.json` when it
 * exists and is at least as fresh as wiring.json (it's written right after
 * wiring in `writeGraph`, so an older sidecar is stale — e.g. a checkpoint
 * killed between the two writes — and must not be served). Old indexes have
 * no sidecar at all, and a corrupt sidecar reads as null — both fall back to
 * the full wiring graph, which satisfies the same consumer contract.
 */
export function loadTraverseCached(outDir) {
    const slim = traversePath(outDir);
    const slimStat = statOf(slim);
    const wiringStat = statOf(wiringPath(outDir));
    if (slimStat && wiringStat && slimStat.mtimeMs >= wiringStat.mtimeMs) {
        const value = loadCached(traverseCache, slim, () => readGraph(slim), () => {
            __parseCount.traverse++;
        });
        if (value)
            return value;
    }
    return loadGraphCached(outDir);
}
/**
 * Drop the cached graph + sidecar for `outDir`, forcing the next load to re-read.
 *
 * The `(mtimeMs, size)` key above is a good invalidator for a build that happened
 * in *another* process, but not for one this process just performed: the
 * pre-query auto-refresh (`refresh.ts`) rewrites the graph and then immediately
 * queries it, and on a filesystem with coarse mtime resolution a same-tick rewrite
 * of the same size would be served from the stale entry. Callers that rebuild must
 * therefore invalidate explicitly rather than trust the clock.
 */
export function invalidateGraphCaches(outDir) {
    graphCache.delete(wiringPath(outDir));
    askIndexCache.delete(askIndexPath(outDir));
    traverseCache.delete(traversePath(outDir));
}
