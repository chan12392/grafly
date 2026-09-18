/**
 * Structural invariants for a built {@link GraphV1} — the Tier-0 quality gate that
 * needs no external oracle. Every one of these must hold for ANY graph the builder
 * emits, in either extraction tier, in any language, or the graph is malformed:
 *
 *   - node ids are unique; names are non-empty; kinds are in the allowed set
 *   - spans are `Lx-Ly` with x <= y
 *   - edge relations and confidences are in the allowed sets
 *   - every edge source is a real node
 *   - every edge target is a real node, EXCEPT the relations that deliberately keep
 *     an unresolved external string (an import specifier, a bare heritage name for
 *     an out-of-repo supertype, or a Java annotation type with no in-repo
 *     `@interface`) — those are a feature of "drop rather than guess",
 *     not a dangling edge.
 *
 * Self-loop `calls` are NOT a violation: direct recursion is a real edge a function
 * has on itself. They are returned separately so a caller (or a recursion-free test
 * fixture) can assert on them explicitly.
 *
 * Pure and dependency-free so it can run in a test, in `graft check`, or over a
 * `wiring.json` read straight off disk. `scripts/graph-quality.mjs` keeps its own
 * standalone copy on purpose, so the CLI report still works when `dist/` is stale.
 */
import type { GraphV1 } from "./types.js";
export interface InvariantResult {
    /** One human-readable line per violation; empty when the graph is well-formed. */
    problems: string[];
    /** Direct-recursion `calls` edges (source === target). Informational, not a violation. */
    selfLoopCalls: number;
}
/** Check a graph's structural invariants. `problems` is empty for a valid graph. */
export declare function checkGraphInvariants(graph: GraphV1): InvariantResult;
//# sourceMappingURL=invariants.d.ts.map