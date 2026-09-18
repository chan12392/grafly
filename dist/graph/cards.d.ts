import type { GraphV1 } from "./types.js";
export interface CardFileInfo {
    /** Card path relative to the context dir, e.g. "src/ai/providers.md". */
    card: string;
    /** Source path the card mirrors, e.g. "src/ai/providers.ts". */
    path: string;
    symbols: number;
}
export interface CardStats {
    written: number;
    pruned: number;
    files: CardFileInfo[];
}
/**
 * Write one wiring card per source file into `outDir`, mirroring the source tree,
 * and prune cards whose source no longer exists. Returns what changed.
 */
export declare function writeCards(graph: GraphV1, outDir: string): CardStats;
/**
 * Write `graft/INDEX.md` — the roster an agent `cat`s to orient. Lists the concept
 * nodes on disk and the per-file cards. Deterministic order; no timestamps.
 */
export declare function writeIndex(outDir: string, files: CardFileInfo[]): void;
/** One symbol a concept node covers: its name, kind, and `path:span` pointer. */
export interface CoverRef {
    symbol: string;
    kind: string;
    /** `src/ai/providers.ts:L28-L35` — same vocabulary `graft ask` returns. */
    at: string;
}
/**
 * Backfill each concept node's frontmatter with a `covers:` list — the symbols
 * (and their exact `file:line`) it spans, read from the wiring graph. This is the
 * explicit OKF↔Wiring link: it doubles as grep bait (a `grep <symbol>` lands on
 * the prose node, not just its card) and lets an agent read the span straight
 * from the node without ever opening `wiring.json`.
 *
 * A surgical frontmatter patch: the generated body and every other key are
 * preserved verbatim; only `covers` is added/replaced. Concept nodes are the
 * top-level `.md` files that carry a `slug` (cards live in subdirs, or at the
 * top level without a slug when they mirror a root source; INDEX.md is skipped).
 * On a $0 structure-only build there are no concept nodes, so this is a no-op.
 * Returns the number of nodes enriched.
 */
export declare function writeCovers(graph: GraphV1, outDir: string): number;
//# sourceMappingURL=cards.d.ts.map