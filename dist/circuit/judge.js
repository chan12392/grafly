/**
 * grafly judgment circuit — the morecoffee channel recipe ported to JS:
 * typed features + linear score + an abstain dial over the score gap.
 *
 * Task: disambiguate same-name symbol matches from resolveSymbol().
 * When `grafly callers run` finds 8 different `run` symbols, the circuit
 * scores each candidate and says either "confident: this one" or
 * "abstain: genuinely ambiguous" — the third answer graft never had.
 *
 * Weights are SEED weights: magnitudes follow the measured feature
 * importances from the morecoffee relation_pair channel (same_file ~1.9,
 * structural-rank ~1.6, typed-path ~1.8), re-mapped onto graft's node
 * fields. A locally evaluated feedback model may replace them on the next
 * invocation. Scores remain uncalibrated; model metadata carries its hash.
 * Pure JS, no network or external inference.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { stripOrdinals } from "../graph/traverse.js";
import { rankFeatures, DEFAULT_WEIGHTS, FEATURE_KEYS as MC_FEATURE_KEYS, ARTIFACT, MODEL_SHA256 } from "./mc-channel.js";
export { SYMBOL_CHANNEL } from './mc-channel.js';

/** Feature keys the circuit produces — the converter (scripts/npz-to-weights.mjs)
 * validates a retrained artifact against this list: a weight for a name not
 * here is dead, a name here missing from the artifact scores 0. */
export const FEATURE_KEYS = MC_FEATURE_KEYS;

/** Weights are an ARTIFACT, not code: circuit/weights.json carries the
 * feature weights + abstain gap so a retrained circuit ships as a JSON
 * drop-in — no JS edits. Built-in seeds cover an absent/unparseable file.
 * GRAFLY_WEIGHTS points at an alternate artifact. */
function loadWeights() {
    if (!process.env.GRAFLY_WEIGHTS) return { W: DEFAULT_WEIGHTS, abstain: ARTIFACT.abstain_gap };
    const here = dirname(fileURLToPath(import.meta.url));
    const path = process.env.GRAFLY_WEIGHTS ?? join(here, "weights.json");
    try {
        const d = JSON.parse(readFileSync(path, "utf8"));
        if (!d?.weights || typeof d.weights !== "object")
            throw new Error("missing weights");
        const W = {};
        for (const key of FEATURE_KEYS) {
            const value = Number(d.weights[key] ?? 0);
            if (!Number.isFinite(value))
                throw new Error(`non-finite weight: ${key}`);
            W[key] = value;
        }
        const abstain = Number(d.abstain_gap);
        if (!Number.isFinite(abstain) || abstain <= 0)
            throw new Error("abstain_gap must be positive");
        return { W, abstain };
    }
    catch { /* absent/invalid artifact → seeds */ }
    return {
        W: DEFAULT_WEIGHTS,
        abstain: ARTIFACT.abstain_gap,
    };
}
const _lw = loadWeights();
const W = _lw.W;

/** Score-gap dial: top-two gap below this ⇒ abstain. GRAFLY_ABSTAIN tunes it. */
const _envGap = Number(process.env.GRAFLY_ABSTAIN ?? _lw.abstain);
export const ABSTAIN_GAP = Number.isFinite(_envGap) && _envGap > 0 ? _envGap : _lw.abstain;

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
    const deg = degreeMap(graph);
    const candidates = matches.map(node => ({ id: node.id, node,
        features: matchFeatures(graph, query, node, deg, ctx?.cwdTokens) }));
    const result = rankFeatures(candidates, { weights: W, abstainGap: ABSTAIN_GAP });
    // Retain Grafly's in-process Infinity convention; channel JSON uses null.
    return { ...result, model_sha256: process.env.GRAFLY_WEIGHTS ? null : MODEL_SHA256, gap: result.gap ?? Number.POSITIVE_INFINITY,
        ranked: result.ranked.map(({ id, ...candidate }) => candidate) };
}
