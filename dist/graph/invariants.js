const KINDS = new Set([
    "file", "class", "function", "method", "interface",
    "type", "enum", "struct", "module", "constant", "variable",
]);
const RELATIONS = new Set([
    "contains", "calls", "imports", "references", "implements", "extends",
]);
const CONFIDENCE = new Set([
    "lsp_resolved", "lsp_dispatch", "extracted", "inferred",
]);
// Relations whose target may be a deliberately-unresolved external string rather
// than an in-repo node id: an import's module specifier, a heritage clause naming
// a supertype defined outside the repo (or a generic type parameter), or a Java
// annotation whose type is not declared in-repo. The set is language-agnostic —
// no other producer currently leaves an unresolved `references` target, so a
// future bug elsewhere would be masked here.
const TARGET_MAY_BE_EXTERNAL = new Set(["imports", "extends", "implements", "references"]);
/** Check a graph's structural invariants. `problems` is empty for a valid graph. */
export function checkGraphInvariants(graph) {
    const problems = [];
    const ids = new Set(graph.nodes.map((n) => n.id));
    const seen = new Set();
    for (const n of graph.nodes) {
        if (seen.has(n.id))
            problems.push(`duplicate node id: ${n.id}`);
        seen.add(n.id);
        if (!n.name || !String(n.name).trim())
            problems.push(`empty name: ${n.id}`);
        if (!KINDS.has(n.kind))
            problems.push(`bad kind '${n.kind}': ${n.id}`);
        const m = /^L(\d+)-L(\d+)$/.exec(n.span ?? "");
        if (!m)
            problems.push(`bad span '${n.span}': ${n.id}`);
        else if (Number(m[1]) > Number(m[2]))
            problems.push(`inverted span ${n.span}: ${n.id}`);
    }
    let selfLoopCalls = 0;
    for (const e of graph.edges) {
        if (!RELATIONS.has(e.relation))
            problems.push(`bad relation '${e.relation}': ${e.source}`);
        if (!CONFIDENCE.has(e.confidence))
            problems.push(`bad confidence '${e.confidence}': ${e.source} → ${e.target}`);
        if (!ids.has(e.source))
            problems.push(`dangling source: ${e.source}`);
        if (!ids.has(e.target) && !TARGET_MAY_BE_EXTERNAL.has(e.relation))
            problems.push(`dangling ${e.relation} target: ${e.source} → ${e.target}`);
        if (e.relation === "calls" && e.source === e.target)
            selfLoopCalls++;
    }
    return { problems, selfLoopCalls };
}
//# sourceMappingURL=invariants.js.map