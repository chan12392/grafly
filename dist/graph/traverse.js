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
 * silently hiding the `~2` duplicate from callers/ask lookups. The
 * ordinal can land on any segment, not just the tail (a reopened class shows
 * up as `C~2.m`), so this strips at every segment boundary (`.` or end of
 * string), not just the very end of the string. Exported for judge.js so the
 * circuit's qualified_tail feature matches what resolveSymbol matched. */
export function stripOrdinals(idTail) {
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
