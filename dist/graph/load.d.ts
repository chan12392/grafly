import { type AskIndex } from "../ask/index-file.js";
import type { GraphV1 } from "./types.js";
/** Real parses performed (cache misses), not cache hits — reported by the
 * search daemon's status so cache reuse is observable. */
export declare const __parseCount: {
    graph: number;
    askIndex: number;
    traverse: number;
};
/** Cached `readGraph(wiringPath(outDir))` — same null-on-missing/unparseable
 * semantics, re-reads only when the wiring file's `(mtimeMs, size)` changed.
 * Returns a shared cached reference; callers must not mutate the returned graph. */
export declare function loadGraphCached(outDir: string): GraphV1 | null;
/** Cached `readAskIndex(outDir)` — same semantics, keyed on the sidecar file.
 * Returns a shared cached reference; callers must not mutate the returned index. */
export declare function loadAskIndexCached(outDir: string): AskIndex | null;
/**
 * Slim traversal graph for callers/grep/trace: `wiring-traverse.json` when it
 * exists and is at least as fresh as wiring.json (it's written right after
 * wiring in `writeGraph`, so an older sidecar is stale — e.g. a checkpoint
 * killed between the two writes — and must not be served). Old indexes have
 * no sidecar at all, and a corrupt sidecar reads as null — both fall back to
 * the full wiring graph, which satisfies the same consumer contract.
 */
export declare function loadTraverseCached(outDir: string): GraphV1 | null;
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
