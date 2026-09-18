/**
 * Graph-rank re-ranking for `graft ask` — the fix for lexical keyword-collision.
 *
 * Pure term-overlap ranking treats every node independently, so a node that
 * merely shares a word with the query (a window "overlay" widget) can outrank
 * the node the query is actually about (a scroll-"overlay" config) purely on
 * word count. The graph knows better: the right node is the one wired into the
 * cluster of code the query touches.
 *
 * This module runs personalized PageRank (random-walk-with-restart) over the
 * wiring graph, seeded by the lexical scores. Mass concentrates on nodes that
 * are edge-connected to the matched set; a lexically-matched but structurally
 * isolated node keeps only its own restart mass and sinks. "Lexical proposes,
 * graph disposes." Deterministic, $0, no embeddings — a lexical-seed →
 * graph-rank pipeline, the established alternative to vector search for code.
 */
import type { GraphV1 } from "../graph/types.js";
export interface PageRankOptions {
    /** Restart probability — the mass that teleports back to the seed set each
     * step. Higher keeps the walk closer to the seeds. 0.25 is the standard value. */
    alpha?: number;
    /** Power-iteration count. 25 is plenty to converge on graphs this size. */
    iters?: number;
    /** Restrict the walk to a subgraph: when present, an edge counts only when
     * BOTH endpoints pass, and only passing ids can hold rank mass or seed
     * weight. Seeds outside the filter are silently ignored (same as a seed
     * naming a non-existent node). Omit for the full-graph walk (unchanged
     * behavior). */
    nodeFilter?: (id: string) => boolean;
}
/** Immutable graph topology consumed by the PageRank iteration. Preparing it
 * separately lets a multi-scope query partition one large graph once, instead
 * of rescanning every node and edge for every scope. */
export interface PageRankTopology {
    ids: ReadonlySet<string>;
    adjacency: ReadonlyMap<string, readonly string[]>;
}
export type PageRankRunOptions = Pick<PageRankOptions, "alpha" | "iters">;
/** Build independent PageRank topologies in one node pass and one edge pass.
 * Edges crossing partitions are excluded, exactly like applying a nodeFilter
 * for each partition independently. Returning `undefined` omits a node. */
export declare function preparePageRankPartitions(graph: GraphV1, partitionOfId: (id: string) => string | undefined): Map<string, PageRankTopology>;
/** Prepare one optionally filtered topology. Kept public for callers/tests that
 * reuse the same graph across multiple seed sets. */
export declare function preparePageRankTopology(graph: GraphV1, nodeFilter?: (id: string) => boolean): PageRankTopology;
/**
 * Personalized PageRank over the wiring graph.
 *
 * `seeds` maps node id → restart weight (a node's lexical score; only positive
 * weights matter). The graph is treated as UNDIRECTED — for "understand this
 * area" a callee is as relevant as a caller. Returns a score per node
 * normalized so the top node is 1; nodes untouched by the walk are absent.
 *
 * Edges whose endpoints aren't both real nodes (e.g. an unresolved import
 * module string) are ignored, so only genuine symbol-to-symbol wiring counts.
 */
export declare function personalizedPageRank(graph: GraphV1, seeds: Map<string, number>, opts?: PageRankOptions): Map<string, number>;
/** Run PageRank on an already prepared topology. This is numerically identical
 * to {@link personalizedPageRank}; it only removes repeated topology scans. */
export declare function personalizedPageRankPrepared(topology: PageRankTopology, seeds: Map<string, number>, opts?: PageRankRunOptions): Map<string, number>;
//# sourceMappingURL=graphrank.d.ts.map