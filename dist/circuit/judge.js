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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { stripOrdinals } from "../graph/traverse.js";

/** Feature keys the circuit produces — the converter (scripts/npz-to-weights.mjs)
 * validates a retrained artifact against this list: a weight for a name not
 * here is dead, a name here missing from the artifact scores 0. */
export const FEATURE_KEYS = ["qualified_tail", "exact_name", "path_overlap",
    "degree", "kind_hint", "vendored", "test_path", "cwd_affinity", "bias"];

/** Weights are an ARTIFACT, not code: circuit/weights.json carries the
 * feature weights + abstain gap so a retrained circuit ships as a JSON
 * drop-in — no JS edits. Built-in seeds cover an absent/unparseable file.
 * GRAFLY_WEIGHTS points at an alternate artifact. */
function loadWeights() {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = process.env.GRAFLY_WEIGHTS ?? join(here, "weights.json");
    try {
        const d = JSON.parse(readFileSync(path, "utf8"));
        if (d?.weights && typeof d.weights === "object")
            return { W: d.weights, abstain: Number(d.abstain_gap ?? 0.5) };
    }
    catch { /* absent/corrupt artifact → seeds */ }
    return {
        W: { qualified_tail: 1.9, exact_name: 1.6, path_overlap: 1.4,
             degree: 0.9, kind_hint: 0.8, vendored: -2.0,
             test_path: -0.8, cwd_affinity: 1.5, bias: -0.3 },
        abstain: 0.5,
    };
}
const _lw = loadWeights();
const W = _lw.W;

/** Score-gap dial: top-two gap below this ⇒ abstain. GRAFLY_ABSTAIN tunes it. */
export const ABSTAIN_GAP = Number(process.env.GRAFLY_ABSTAIN ?? _lw.abstain);

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

/**
 * id → edge-touch count, built once per judgeSymbols call. Scoring each
 * candidate by scanning graph.edges is O(matches × edges) — 44M scans for
 * 300 matches on a 144k-edge graph (12s). One pass + lookup is O(edges). */
function degreeMap(graph) {
    const m = new Map();
    for (const e of graph.edges) {
        m.set(e.source, (m.get(e.source) || 0) + 1);
        m.set(e.target, (m.get(e.target) || 0) + 1);
    }
    return m;
}

/** Per-candidate feature vector for (query, node) over the graph.
 * cwdTokens = tokens of the caller's cwd dir relative to the repo root
 * (empty Set when cwd is outside the repo — feature stays 0 for all). */
export function matchFeatures(graph, query, node, deg, cwdTokens) {
    const q = query.toLowerCase();
    const dot = q.lastIndexOf(".");
    const hasQualifier = dot > 0;
    const tail = hasQualifier ? q.slice(dot + 1) : q;
    const prefix = hasQualifier ? q.slice(0, dot) : "";

    // Strip mint-time `~N` ordinals like resolveSymbol does, so a `C.m`
    // query scores `#C~2.m` the same as `#C.m` — it resolved, it should feature.
    const hashIdx = node.id.indexOf("#");
    const lowerId = (hashIdx === -1 ? node.id : node.id.slice(0, hashIdx + 1) +
        stripOrdinals(node.id.slice(hashIdx + 1))).toLowerCase();
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

    const degree = (deg ?? degreeMap(graph)).get(node.id) ?? 0;

    const qTokens = new Set(tokens(q));
    let kindHit = 0;
    for (const [kind, words] of Object.entries(KIND_WORDS)) {
        if (words.some((w) => qTokens.has(w)) &&
            node.kind.toLowerCase().includes(kind.slice(0, 4))) {
            kindHit = 1;
        }
    }

    // Vendored/artifact paths systematically win a degree-only ranking —
    // libraries are the most-connected code. Measured on merlection_3d:
    // 38/40 ambiguous bare-name queries ranked a site-packages or
    // qa-artifacts symbol top-1. The penalty exists so project source
    // outranks vendored duplicates of the same name.
    const vendored = VENDORED_PATH.test(node.path) ? 1 : 0;

    // Test files answer "how is X exercised" queries; for a bare symbol
    // query the production definition is usually the intent. Mild penalty —
    // unlike vendored, a test match can still be the right answer.
    const testPath = TEST_PATH.test(node.path) ? 1 : 0;

    // cwd affinity: running `callers close` from inside rhino_plugin/
    // almost certainly means ChatSection.close, not a distant file's.
    // The caller's location IS query context — bare names carry no other.
    let cwdAffinity = 0;
    if (cwdTokens?.size) {
        const dir = node.path.slice(0, node.path.lastIndexOf("/"));
        const dTokens = new Set(tokens(dir));
        let hit = 0;
        for (const t of cwdTokens) if (dTokens.has(t)) hit++;
        cwdAffinity = hit / cwdTokens.size;
    }

    return {
        qualified_tail: qualifiedTail ? 1 : 0,
        exact_name: exactName ? 1 : 0,
        path_overlap: pathOverlap,
        degree: Math.min(Math.log1p(degree) / 3, 1),
        kind_hint: kindHit,
        vendored,
        test_path: testPath,
        cwd_affinity: cwdAffinity,
        bias: 1,
    };
}

/** Dependency/artifact trees whose symbols are copies, not the answer. */
const VENDORED_PATH = /site-packages|dist-packages|node_modules|__pycache__|\/vendor\/|_vendor|third_party|\.venv|\/venv\/|qa-artifacts|frozen-gate|\/staging\/|backup/i;
/** Test files — penalized mildly for bare-name intent. */
const TEST_PATH = /(^|\/)test[s]?_|_test\.|(^|\/)tests?\/|\.test\.|\.spec\.|test_[^/]*\.py$/i;

export function scoreMatch(graph, query, node, deg, cwdTokens) {
    const f = matchFeatures(graph, query, node, deg, cwdTokens);
    return Object.keys(W).reduce((s, k) => s + W[k] * (f[k] ?? 0), 0);
}

/** Tokens of `cwd` relative to `root` — the caller's location as query
 * context. Empty when cwd is outside the repo (feature-neutral). */
export function cwdContextTokens(root, cwd) {
    const rel = relative(root, cwd).split(sep).join("/");
    if (!rel || rel.startsWith(".."))
        return new Set();
    return new Set(tokens(rel));
}

/**
 * Judge same-name matches. Returns {verdict, gap, ranked} where ranked is
 * matches scored and sorted desc; verdict is "confident" when a single
 * match exists or the top-two gap clears ABSTAIN_GAP, else "abstain".
 * ctx.cwdTokens (optional) supplies the cwd-affinity feature.
 */
export function judgeSymbols(graph, query, matches, ctx) {
    const cwdTokens = ctx?.cwdTokens;
    const deg = degreeMap(graph);
    const ranked = matches
        .map((node) => {
            const f = matchFeatures(graph, query, node, deg, cwdTokens);
            const score = Object.keys(W).reduce((s, k) => s + W[k] * (f[k] ?? 0), 0);
            return { node, score, features: f };
        })
        .sort((a, b) => b.score - a.score);
    const gap = ranked.length > 1 ? ranked[0].score - ranked[1].score
        : Number.POSITIVE_INFINITY;
    const verdict = ranked.length === 1 || gap >= ABSTAIN_GAP
        ? "confident" : "abstain";
    const reason = verdictReason(verdict, gap, ranked);
    return { verdict, gap, ranked, reason };
}

/** Why the verdict came out this way — the part an LLM consumer needs to
 * decide whether the ranking is trustworthy:
 *  - confident: which features actually separated top-1 from top-2
 *  - abstain:   tie (identical evidence) vs weak_gap (real but small
 *               separation)
 *  - pool flags (either verdict): vendored_pool when every candidate lives
 *    in vendored/generated paths; lone_source when exactly one candidate is
 *    project source — the top-1 then won by elimination, not by preferred
 *    evidence, which is a different kind of "confident" the consumer should
 *    see. Measured on merlection: `render`/`__eq__` picked a lone test
 *    symbol over 40-270 vendored duplicates this way. */
function verdictReason(verdict, gap, ranked) {
    if (ranked.length === 1)
        return "unique";
    const vendoredPool = ranked.every((r) => r.features.vendored === 1);
    const nonVendored = vendoredPool ? 0 : ranked.filter((r) => r.features.vendored === 0).length;
    const poolFlag = vendoredPool ? "|vendored_pool" : nonVendored === 1 ? "|lone_source" : "";
    if (verdict === "confident") {
        // |Δfeature × weight|, desc — the evidence that decided it.
        const diffs = Object.keys(W)
            .map((k) => [k, ((ranked[0].features[k] ?? 0) - (ranked[1].features[k] ?? 0)) * (W[k] ?? 0)])
            .filter(([, d]) => d > 1e-9)
            .sort((a, b) => b[1] - a[1]);
        const by = diffs.slice(0, 3).map(([k]) => k).join("+") || "score";
        return `by:${by}` + poolFlag;
    }
    const cause = gap < 1e-6 ? "tie" : "weak_gap";
    return cause + poolFlag;
}

/**
 * Crux-pass gate: is this node trivial enough that the LLM's own rules
 * (SYSTEM_PROMPT in ai/crux.js — trivial getter/data-holder/one-line
 * delegation → one-sentence summary + crux 0/0) make its answer predictable?
 * If so the deterministic entry is written locally and the node is left out
 * of the LLM call — same entry shape, zero round-trip.
 *
 * Conservative by construction: anything ambiguous returns false, so the
 * node stays in the LLM batch. Quality is preserved by abstaining to the
 * model whenever the cheap judgment is unsure.
 */
const TRIVIAL_KINDS = new Set(["type", "interface", "enum", "constant",
    "property", "field", "type_alias", "typedef"]);
const CTRL_RE = /\b(if|elif|else|for|foreach|while|switch|case|match|try|except|catch|finally|await|yield|raise|throw|return\s+[^;\n]*[+\-*/<>=&|?]|=>)\b/;

export function isTrivialNode(node, sourceLines) {
    const kind = (node.kind || "").toLowerCase();
    if (TRIVIAL_KINDS.has(kind))
        return true;
    const start = node.startLine, end = node.endLine;
    if (!start || !end || end - start + 1 > 4)
        return false;
    const body = sourceLines.slice(start - 1, end).join("\n");
    if (CTRL_RE.test(body))
        return false;
    // A signature-bearing short span (getter, delegation, plain holder) —
    // the case the LLM answers with crux 0/0 anyway.
    return Boolean(node.signature) || kind === "method" || kind === "function";
}

/** Deterministic crux entry for a node the gate classified as trivial. */
export function localCruxEntry(node) {
    const name = String(node.id).split(/[#.]/).pop();
    const kind = (node.kind || "symbol").toLowerCase();
    const sig = node.signature ? ` — \`${node.signature}\`` : "";
    return {
        id: node.id,
        summary: `Trivial ${kind} \`${name}\`${sig} — surface declaration, no core logic.`,
        crux_start: 0,
        crux_end: 0,
    };
}
