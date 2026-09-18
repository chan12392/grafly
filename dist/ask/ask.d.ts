import { type Savings } from "../context/savings.js";
import type { NodeV1, Relation } from "../graph/types.js";
import { type AppliedRule } from "../brain/attach.js";
export interface AskHit {
    kind: "concept" | "symbol" | "caller" | "callee";
    title: string;
    /** A `file` or `file:Lx-Ly` pointer the agent can open directly. */
    pointer: string;
    snippet: string;
    relation?: Relation;
    related?: string[];
    score: number;
    /** The actual source at `pointer`, sliced from disk when `source` is on.
     * This is what makes `ask` substitutive — the agent reads the span here
     * instead of opening the file, so no source read happens on top of the query. */
    code?: string;
    /** Multi-scope repos only: the ranking scope (path prefix, "" = root) this
     * hit was ranked within — answers "which sub-project is this from?". Drives
     * the `[scope/] ` label in formatAsk. Absent on single-scope repos. */
    scope?: string;
}
/** Internal file-aware ranking group. The first hit is the one document that
 * participates in a higher-level ranker; the remaining hits are projected only
 * after every ranked group has emitted its leader. */
export interface AskRankingGroup {
    key: string;
    hits: AskHit[];
    /** Exact baseline-scored members of this group, in baseline order. Populated
     * only in opt-in metadata so a workspace top lock never reuses a pooled
     * leader score for a secondary span. */
    baselineHits?: AskHit[];
    coverage: number;
    coverageStrong: number;
}
/** Internal metadata used by workspace federation to fuse file documents
 * before projecting symbol spans. It is opt-in and never appears in normal
 * CLI/API results. */
export interface AskRankingMetadata {
    groups: AskRankingGroup[];
    baseline: Array<{
        group: string;
        hit: AskHit;
    }>;
    baselineCoverage?: number;
    baselineCoverageStrong?: number;
}
export interface AskResult {
    query: string;
    mode: "structural" | "lexical" | "empty";
    /** For structural mode: the symbol whose neighbours we walked. */
    subject?: string;
    /** Authoritative result order. Lexical results preserve each hit's raw
     * relevance score, but select distinct-file leaders before sibling spans, so
     * callers must not re-sort this list by `score`. */
    hits: AskHit[];
    note?: string;
    /** Token-saving estimate, set only in `--source` (retriever) mode: the whole
     * size of the distinct files these hits point into, i.e. the baseline cost of
     * reading them instead of this pack. Computed from file sizes stored at build. */
    saved?: {
        files: number;
        baselineChars: number;
    };
    /** Lexical mode only: share (0..1) of the query's distinct terms the TOP hit
     * matched. A relevance signal for callers that inject packs unprompted (the
     * Claude prompt hook): a low share means the query's words barely overlap the
     * best result, i.e. the pack is probably noise for this prompt. Absent in
     * structural mode — a resolved "who calls X" is itself the relevance signal. */
    coverage?: number;
    /** Like {@link coverage}, but the top hit's idf-weighted matched share over
     * its NAME + PATH fields ONLY (body excluded) — a match-STRENGTH signal:
     * "did the query hit a high-value field, or only incidental body tokens?".
     * A body-only collision (a variable that happens to share a query word) has
     * `coverageStrong === 0` while `coverage` can still look respectable. Used by
     * workspace federation to gate a weak child out of the cross-repo ranking.
     * Absent in structural mode; same lexical-only contract as `coverage`. */
    coverageStrong?: number;
    /** Multi-scope lexical results only: which scopes federated into the fused
     * ranking, plus scopes that matched too weakly to federate (with their best
     * doc id). Drives formatAsk's `matched in:` / `also matched:` footer.
     * Absent on single-scope repos — zero output change there. */
    scopes?: {
        federated: string[];
        alsoMatched: {
            scope: string;
            bestId: string;
        }[];
    };
    /** @internal Opt-in latent file groups plus the exact pre-file-ranking list. */
    ranking?: AskRankingMetadata;
    /** Rules from the attached Trail brain that govern the symbols in `hits`.
     * Absent when the repo has no brain linked, or when none of its rules touch
     * this answer. Populated in `--source` mode only, alongside `saved`: a pack
     * the agent does not read the code from has nothing for a rule to sit beside. */
    rules?: AppliedRule[];
}
/** Score a document's token counts against the query counts (name field
 * pre-weighted by caller). Each shared term is weighted by its inverse document
 * frequency (`idf`), so a word that appears in many nodes — "overlay" across a
 * whole widget subsystem, or a repeated word in a pasted issue body — counts for
 * far less than a rare, discriminating identifier ("scrolling"). Without idf,
 * pure term-frequency lets an incidental common word dominate the ranking; this
 * is the lexical half of the keyword-collision fix (graph-rank is the other). */
/** Test files rarely answer "how does X work" / "where is Y" — they mirror the
 * real symbol's tokens, so a test can out-score the definition on a lexical tie
 * and land as the top hit (observed: an `ask` returning a `Test…` function first,
 * sending the agent to the wrong file). A multiplicative de-rank keeps tests in
 * the results (they still matter for "where are the tests") but below the real
 * definition. Covers Go (`_test.go`), JS/TS (`.test.` / `.spec.`), and test dirs. */
export declare function isTestPath(path: string): boolean;
/** Idf-weighted share (0..1) of the query a document matches: each query term
 * counts by its rarity, so this separates task prompts from chatter in a way a
 * raw term count can't. A conversational prompt's words are either off-corpus
 * (rare → heavy, unmatched → sinks the ratio) or generic code words ("list",
 * "write": common → near-weightless even when they collide with a symbol name);
 * a task prompt matches exactly its rare, discriminating identifiers. Terms the
 * corpus has never seen take `dfltIdf` (the df=0 weight). */
/** The match-STRENGTH share behind `coverageStrong`: idf-weighted share of the
 * query matched in the node's NAME field ONLY. The PATH field is deliberately
 * excluded — a coincidental generic directory (`gateway/`) or file basename
 * (`gateway.ts`) in an unrelated repo would otherwise clear the strength gate
 * and float that repo to the top; an on-topic path-organized repo is still
 * rescued by the broad-coverage HIGH_FLOOR clause instead. For the same reason
 * a `kind:"file"` node contributes zero strength: its `name` is a basename (a
 * path component), not a symbol name, so a file whose basename happens to share
 * a query word is not a strong match. */
export declare function strongShare(q: Map<string, number>, node: NodeV1, doc: {
    name: Map<string, number>;
}, idf: Map<string, number>, dfltIdf: number): number;
export interface AskOptions {
    contextDir?: string;
    limit?: number;
    /** Inline the source at each `path:Lx-Ly` hit, sliced from `dir`. Turns the
     * pack from a locator into a retriever so the agent needn't re-open the file. */
    source?: boolean;
    /** Re-rank lexical hits by graph connectivity (personalized PageRank over the
     * wiring edges), demoting same-word collisions and rescuing strongly-connected
     * neighbours the query didn't name. On by default; set false for pure lexical. */
    graphRank?: boolean;
    /** With `source`: inline each hit's WHOLE definition span (capped at
     * {@link MAX_SPAN_LINES}) instead of the default crux-first slice. The
     * default inlines the ≤8-line LLM-chosen crux when a node has one — the
     * decision point, ~10× cheaper than the full span — and the pack marks each
     * crux so the agent knows `--full` (or the file itself) has the rest. */
    full?: boolean;
    /** Narrow the doc/node set to this path prefix BEFORE scoring (segment-aware,
     * like `scopeOf` — "frontend" never matches "frontend-utils"). Per-scope
     * IDF/BM25/walk come free: the filtered set is usually one scope, so the
     * existing multi-scope machinery degrades to its single-scope passthrough
     * with no scope labels. A prefix matching nothing indexed throws. */
    in?: string;
    /** @internal Defer file-first projection to a downstream authoritative
     * ranking stage (currently workspace federation). Direct callers should
     * leave this unset. */
    fileFirst?: boolean;
    /** @internal Bounded file scoring control. */
    fileComplement?: boolean;
    /** @internal Exact baseline top-hit lock. Requires bounded file
     * scoring and composes it with the file-first frontier. */
    fileTopLock?: boolean;
    /** @internal Return latent file queues and the exact baseline list so a
     * workspace parent can fuse files before projecting spans. */
    includeRankingMetadata?: boolean;
}
/** Answer a query from the graft/ graph at `dir`. Deterministic, $0. */
export declare function ask(dir: string, query: string, opts?: AskOptions): AskResult;
export interface SkeletonEntry {
    name: string;
    kind: string;
    span: string;
    signature: string | null;
    /** First line of the Tier-2 summary, when the node has one. */
    summary?: string;
}
export interface SkeletonResult {
    file: string;
    entries: SkeletonEntry[];
    note?: string;
    /** Tokens-saved baseline: this file read whole vs the signatures-only view. */
    saved?: Savings;
}
/** Signatures-only view of one file, straight from the wiring graph — the
 * cheapest way to understand a file's API surface (~10× less than reading it).
 * `file` is matched as an exact repo-relative path, then as a basename. */
export declare function skeleton(dir: string, file: string, opts?: {
    contextDir?: string;
}): SkeletonResult;
/** Render a {@link SkeletonResult} as compact markdown. */
export declare function formatSkeleton(r: SkeletonResult): string;
/** Render an {@link AskResult} as a compact markdown context pack. */
export declare function formatAsk(r: AskResult): string;
//# sourceMappingURL=ask.d.ts.map