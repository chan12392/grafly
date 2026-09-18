/**
 * grafly judgment circuit — the morecoffee channel recipe ported to JS:
 * typed features + linear score + an abstain dial over the score gap.
 *
 * Task: disambiguate same-name symbol matches from resolveSymbol().
 * When `graft callers run` finds 8 different `run` symbols, the circuit
 * scores each candidate and says either "confident: this one" or
 * "abstain: genuinely ambiguous" — the third answer graft never had.
 *
 * Weights are SEED weights: magnitudes follow the measured feature
 * importances from the morecoffee relation_pair channel (same_file ~1.9,
 * structural-rank ~1.6, typed-path ~1.8), re-mapped onto graft's node
 * fields. They are not yet retrained on graft usage — collect real
 * disambiguation outcomes before trusting absolute values. Pure JS, no
 * model files, no network.
 */

const W = {
    qualified_tail: 1.9,  // query's qualified tail honored by candidate id
    exact_name: 1.6,      // bare exact name equality
    path_overlap: 1.4,    // query prefix tokens appear in candidate path
    degree: 0.9,          // well-connected symbol is likelier the intent
    kind_hint: 0.8,       // query kind word matches node.kind
    bias: -0.3,
};

/** Score-gap dial: top-two gap below this ⇒ abstain. GRAFLY_ABSTAIN tunes it. */
export const ABSTAIN_GAP = Number(process.env.GRAFLY_ABSTAIN ?? 0.5);

const KIND_WORDS = {
    method: ["method", "methods"],
    function: ["function", "func", "fn"],
    class: ["class"],
    type: ["type", "interface", "struct", "enum"],
    file: ["file"],
};

function tokens(s) {
    return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
}

/** Per-candidate feature vector for (query, node) over the graph. */
export function matchFeatures(graph, query, node) {
    const q = query.toLowerCase();
    const dot = q.lastIndexOf(".");
    const hasQualifier = dot > 0;
    const tail = hasQualifier ? q.slice(dot + 1) : q;
    const prefix = hasQualifier ? q.slice(0, dot) : "";

    const lowerId = node.id.toLowerCase();
    const qualifiedTail = hasQualifier &&
        (lowerId.endsWith("#" + q) || lowerId.endsWith("." + q));
    const exactName = node.name.toLowerCase() === tail;

    // Query qualifier tokens (e.g. "cache" in "Cache.get") vs path tokens —
    // the file/dir a symbol lives in is graft's version of same_file.
    const pTokens = new Set(tokens(node.path));
    const qPrefix = new Set(tokens(prefix));
    let overlap = 0;
    for (const t of qPrefix) if (pTokens.has(t)) overlap++;
    const pathOverlap = qPrefix.size ? overlap / qPrefix.size : 0;

    let degree = 0;
    for (const e of graph.edges) {
        if (e.source === node.id || e.target === node.id) degree++;
    }

    const qTokens = new Set(tokens(q));
    let kindHit = 0;
    for (const [kind, words] of Object.entries(KIND_WORDS)) {
        if (words.some((w) => qTokens.has(w)) &&
            node.kind.toLowerCase().includes(kind.slice(0, 4))) {
            kindHit = 1;
        }
    }

    return {
        qualified_tail: qualifiedTail ? 1 : 0,
        exact_name: exactName ? 1 : 0,
        path_overlap: pathOverlap,
        degree: Math.min(Math.log1p(degree) / 3, 1),
        kind_hint: kindHit,
        bias: 1,
    };
}

export function scoreMatch(graph, query, node) {
    const f = matchFeatures(graph, query, node);
    return Object.keys(W).reduce((s, k) => s + W[k] * f[k], 0);
}

/**
 * Judge same-name matches. Returns {verdict, gap, ranked} where ranked is
 * matches scored and sorted desc; verdict is "confident" when a single
 * match exists or the top-two gap clears ABSTAIN_GAP, else "abstain".
 */
export function judgeSymbols(graph, query, matches) {
    const ranked = matches
        .map((node) => ({ node, score: scoreMatch(graph, query, node) }))
        .sort((a, b) => b.score - a.score);
    const gap = ranked.length > 1 ? ranked[0].score - ranked[1].score
        : Number.POSITIVE_INFINITY;
    const verdict = ranked.length === 1 || gap >= ABSTAIN_GAP
        ? "confident" : "abstain";
    return { verdict, gap, ranked };
}
