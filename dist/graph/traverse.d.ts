/**
 * Pure graph-traversal core shared by `grafly callers` (its `--direction`/
 * `--depth` flags) and `ask`'s structural intent path.
 *
 * Centralizes the symbol-resolution contract (bare name, qualified id-suffix,
 * last-segment fallback, `--in` narrowing) so all surfaces agree on what a
 * query like `Cache.get` or `hashstructure.Hash` means, and the direction-aware
 * (incoming/outgoing) depth-1 and BFS edge walks over the wiring graph.
 *
 * No I/O here: callers pass in an already-loaded `GraphV1` (via
 * `loadGraphCached`), which keeps this module trivially unit-testable against
 * hand-built fixture graphs.
 */
import type { GraphV1, NodeV1, Relation } from "./types.js";
/** Which way to walk the wiring graph: `in` = incoming edges (who points at
 * the symbol — callers / blast radius), `out` = outgoing edges (what the symbol
 * points at — callees). */
export type Direction = "in" | "out";
/** A resolved symbol-search hit. Reserved for future disambiguation metadata
 * (e.g. why a query matched); today it wraps the node 1:1. */
export interface SymbolMatch {
    node: NodeV1;
}
export interface ResolveSymbolOptions {
    /** Narrow candidates to nodes at or under this repo-relative path prefix —
     * the same segment-aware rule `ask --in` and `grep --in` use, so `--in` means
     * one thing across every command. Normalized here, so either separator works. */
    in?: string;
}
/**
 * Resolve a query string to every matching node in the graph.
 *
 * Matching, in order:
 *  1. Non-file nodes whose `name` equals the query case-insensitively, OR
 *     whose `id` ends with `#<query>` or `.<query>` case-insensitively — this
 *     is what makes a qualified name like `Cache.get` resolve against an id
 *     like `src/cache.ts#Cache.get`.
 *  2. If that yields nothing and the query contains a `.`, retry with just
 *     the last dot-segment as a bare name (`hashstructure.Hash` → `Hash`) —
 *     covers package-qualified names (e.g. Go) whose id never contains the
 *     package prefix.
 *  3. If *that* still yields nothing and the query looks like a filename
 *     (contains `.`, no `#`), fall back to `kind: 'file'` nodes matched by
 *     name or path.
 *
 * `opts.in` then filters whichever candidate set was produced, by path
 * substring. Multiple matches are not an error — every match is returned.
 */
export declare function resolveSymbol(graph: GraphV1, query: string, opts?: ResolveSymbolOptions): NodeV1[];
/** Remove extractor collision ordinals for qualified-name matching. */
export declare function stripOrdinals(idTail: string): string;
/** One traversed edge. `node` is null when the edge's other endpoint isn't a
 * real node in the graph (e.g. an unresolved import module string) — such
 * hits are kept, labeled by the raw id, rather than dropped. */
export interface EdgeHit {
    node: NodeV1 | null;
    id: string;
    relation: Relation;
    depth: number;
}
/**
 * BFS over walk-relation edges from *multiple* seed nodes at once, in the given
 * `direction` (`in` = incoming, the default — "who breaks if this changes";
 * `out` = outgoing — "what this reaches"). Used when one logical unit spans several graph node ids — e.g. a file plus
 * every symbol defined in it, since a `calls`/`references`/etc. edge from
 * another file always targets the SYMBOL id, never the FILE id, so walking the
 * file node alone misses dependents that call into it rather than merely
 * importing it.
 *
 * Every seed is pre-marked visited (so a seed can never appear as its own
 * hit, and an edge between two seeds is never reported), then the walk
 * proceeds breadth-first: each reached node deduped by id and
 * reported once, at the depth it was first reached from *any* seed.
 */
export declare function impactOfMany(graph: GraphV1, seeds: NodeV1[], maxDepth?: number, direction?: Direction): EdgeHit[];
