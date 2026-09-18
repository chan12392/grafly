import { type AskIndex } from "../ask/index-file.js";
import type { GraphV1 } from "./types.js";
/** Real parses performed (cache misses), not cache hits — exported for tests
 * so the invalidation contract can be pinned down without spying on `fs`. */
export declare const __parseCount: {
    graph: number;
    askIndex: number;
};
/** Test-only: zero the counters (module state persists across a test file). */
export declare function __resetParseCounts(): void;
/** Cached `readGraph(wiringPath(outDir))` — same null-on-missing/unparseable
 * semantics, re-reads only when the wiring file's `(mtimeMs, size)` changed.
 * Returns a shared cached reference; callers must not mutate the returned graph. */
export declare function loadGraphCached(outDir: string): GraphV1 | null;
/** Cached `readAskIndex(outDir)` — same semantics, keyed on the sidecar file.
 * Returns a shared cached reference; callers must not mutate the returned index. */
export declare function loadAskIndexCached(outDir: string): AskIndex | null;
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
export declare function invalidateGraphCaches(outDir: string): void;
//# sourceMappingURL=load.d.ts.map