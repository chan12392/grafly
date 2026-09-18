import { WALK_RELATIONS } from "./relations.js";
import { assertPrefixIndexed, pathUnderPrefix } from "./scopes.js";
import { normalizePathPrefix } from "../util/paths.js";
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
export function resolveSymbol(graph, query, opts = {}) {
    const lowerQuery = query.toLowerCase();
    const looksLikeFilename = query.includes(".") && !query.includes("#");
    let matches = symbolMatches(graph.nodes, lowerQuery);
    if (matches.length === 0 && query.includes(".")) {
        const lastSegment = query.slice(query.lastIndexOf(".") + 1).toLowerCase();
        if (lastSegment) {
            matches = graph.nodes.filter((n) => n.kind !== "file" && n.name.toLowerCase() === lastSegment);
        }
    }
    if (matches.length === 0 && looksLikeFilename) {
        matches = graph.nodes.filter((n) => n.kind === "file" &&
            (n.name.toLowerCase() === lowerQuery ||
                n.path.toLowerCase() === lowerQuery ||
                n.path.toLowerCase().endsWith("/" + lowerQuery)));
    }
    if (opts.in) {
        const prefix = normalizePathPrefix(opts.in);
        assertPrefixIndexed(graph, prefix);
        matches = matches.filter((n) => pathUnderPrefix(n.path, prefix));
    }
    return matches;
}
/** Strips extract.ts's mint-time disambiguation ordinals (`~2`, `~3`, ...)
 * from segment ends in a dotted id-tail — the same shape extract.ts mints
 * when a document-order duplicate definition would otherwise collide with an
 * already-minted id (see extract.ts's mint-time uniqueness comment). Without
 * this, a qualified query like `C.m` only ever matches the bare id (`#C.m`),
 * silently hiding the `~2` duplicate from callers/ask/MCP lookups. The
 * ordinal can land on any segment, not just the tail (a reopened class shows
 * up as `C~2.m`), so this strips at every segment boundary (`.` or end of
 * string), not just the very end of the string. */
function stripOrdinals(idTail) {
    return idTail.replace(/~\d+(?=\.|$)/g, "");
}
function symbolMatches(nodes, lowerQuery) {
    const suffixHash = "#" + lowerQuery;
    const suffixDot = "." + lowerQuery;
    return nodes.filter((n) => {
        if (n.kind === "file")
            return false;
        if (n.name.toLowerCase() === lowerQuery)
            return true;
        const lowerId = n.id.toLowerCase();
        const hashIdx = lowerId.indexOf("#");
        const candidateId = hashIdx === -1 ? lowerId : lowerId.slice(0, hashIdx + 1) + stripOrdinals(lowerId.slice(hashIdx + 1));
        return candidateId.endsWith(suffixHash) || candidateId.endsWith(suffixDot);
    });
}
/** Depth-1: nodes with a walk-relation edge whose target is `symbol`. */
export function callersOf(graph, symbol) {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const hits = [];
    for (const e of graph.edges) {
        if (!WALK_RELATIONS.has(e.relation) || e.target !== symbol.id)
            continue;
        hits.push({ node: byId.get(e.source) ?? null, id: e.source, relation: e.relation, depth: 1 });
    }
    return hits;
}
/** Depth-1: walk-relation edges whose source is `symbol`. */
export function calleesOf(graph, symbol) {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const hits = [];
    for (const e of graph.edges) {
        if (!WALK_RELATIONS.has(e.relation) || e.source !== symbol.id)
            continue;
        hits.push({ node: byId.get(e.target) ?? null, id: e.target, relation: e.relation, depth: 1 });
    }
    return hits;
}
/**
 * BFS over INCOMING walk-relation edges from `symbol`, up to `maxDepth` hops
 * — "who breaks if this changes". Each reached node is deduped by id and
 * reported once, at the depth it was first reached (a diamond-shaped
 * dependency graph counts its convergence node exactly once).
 */
export function impactOf(graph, symbol, maxDepth = 2) {
    return impactOfMany(graph, [symbol], maxDepth);
}
/**
 * BFS over walk-relation edges from *multiple* seed nodes at once, in the given
 * `direction` (`in` = incoming, the default — "who breaks if this changes";
 * `out` = outgoing — "what this reaches"). The multi-seed generalization of
 * {@link impactOf} (`impactOf(g, n, d)` is exactly `impactOfMany(g, [n], d)`).
 * Used when one logical unit spans several graph node ids — e.g. a file plus
 * every symbol defined in it, since a `calls`/`references`/etc. edge from
 * another file always targets the SYMBOL id, never the FILE id, so walking the
 * file node alone misses dependents that call into it rather than merely
 * importing it.
 *
 * Every seed is pre-marked visited (so a seed can never appear as its own
 * hit, and an edge between two seeds is never reported), then the walk
 * proceeds exactly like `impactOf`'s: each reached node deduped by id and
 * reported once, at the depth it was first reached from *any* seed.
 */
export function impactOfMany(graph, seeds, maxDepth = 2, direction = "in") {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    // Adjacency keyed for the walk direction, restricted to walk relations:
    //   'in'  → key = edge.target, neighbour = edge.source (who points AT key)
    //   'out' → key = edge.source, neighbour = edge.target (what key points TO)
    const adj = new Map();
    for (const e of graph.edges) {
        if (!WALK_RELATIONS.has(e.relation))
            continue;
        const key = direction === "in" ? e.target : e.source;
        const other = direction === "in" ? e.source : e.target;
        const entry = { other, relation: e.relation };
        const arr = adj.get(key);
        if (arr)
            arr.push(entry);
        else
            adj.set(key, [entry]);
    }
    const visited = new Set(seeds.map((s) => s.id));
    const hits = [];
    let frontier = [...visited];
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
        const next = [];
        for (const current of frontier) {
            for (const { other, relation } of adj.get(current) ?? []) {
                if (visited.has(other))
                    continue;
                visited.add(other);
                hits.push({ node: byId.get(other) ?? null, id: other, relation, depth });
                next.push(other);
            }
        }
        frontier = next;
    }
    return hits;
}
/** Every non-file node whose `path` equals `fileNode.path` — the symbols
 * defined in that file. */
function symbolsInFile(graph, fileNode) {
    return graph.nodes.filter((n) => n.kind !== "file" && n.path === fileNode.path);
}
/**
 * `impactOf`, generalized for a `kind: 'file'` seed: aggregates the BFS over
 * the file node AND every symbol node defined in that file (via
 * {@link impactOfMany} — dedup by id, min depth, seeds excluded). Fixes a file
 * query silently dropping dependents that `calls`/`references`/etc. into a
 * symbol the file defines, rather than merely `imports`-ing the file itself —
 * see this module's header and `impactOfMany`'s doc for why. Symbol-kind
 * queries keep using plain `impactOf`; this is only for file-kind matches.
 */
export function impactOfFile(graph, fileNode, maxDepth = 2, direction = "in") {
    return impactOfMany(graph, [fileNode, ...symbolsInFile(graph, fileNode)], maxDepth, direction);
}
/**
 * The single entry point behind `graft callers` and the MCP `graft_trace_calls`
 * tool, covering all of what were once three commands:
 *   - `direction:in,  depth:1`  → callers      (who calls/references this)
 *   - `direction:out, depth:1`  → callees      (what this calls/references)
 *   - `direction:in,  depth>1`  → blast radius  (transitive dependents)
 *   - `direction:out, depth>1`  → transitive dependencies
 *
 * Depth 1 uses the plain single-hop scan ({@link callersOf}/{@link calleesOf})
 * so `graft callers <symbol>` output is unchanged. Depth >1 runs the BFS, and
 * for a `kind: 'file'` seed aggregates over the symbols the file defines (see
 * {@link impactOfMany}) so file-level dependents aren't silently dropped.
 */
export function edgeWalk(graph, node, direction, depth) {
    if (depth <= 1)
        return direction === "in" ? callersOf(graph, node) : calleesOf(graph, node);
    if (node.kind === "file")
        return impactOfFile(graph, node, depth, direction);
    return impactOfMany(graph, [node], depth, direction);
}
//# sourceMappingURL=traverse.js.map