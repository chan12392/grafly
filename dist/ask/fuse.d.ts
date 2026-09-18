/**
 * Scope-aware ranking for `graft ask`. Pure functions, no fs.
 *
 * The problem: lexical + graph scores are corpus-relative. In a multi-scope
 * repo (a monorepo's `frontend/` + `backend/`, sub-projects under one root),
 * scoring every node against one pooled corpus lets the biggest sub-project set
 * the score scale and drown the small one.
 *
 * This module solves it by keeping the scope PARTITION — each scope is scored
 * and walked separately — while making the resulting scores COMPARABLE, so the
 * combined order can be read straight off the score. Comparability has two
 * requirements, and both must hold or the order is meaningless:
 *
 *   1. shared corpus statistics — the caller scores every scope against the
 *      repo-wide IDF and length prior (see `ask.ts`), so the same term is worth
 *      the same everywhere;
 *   2. a shared normalization denominator — {@link rankScopesAndFuse} divides
 *      every scope by the best raw score in the REPO, not by each scope's own
 *      best (see `globalMaxLex` there).
 *
 * Issue #117 was the consequence of neither holding. Each scope divided by its
 * own maximum, so a barely-relevant scope's top hit normalized to ~1.0 exactly
 * like the genuinely relevant scope's top hit; RRF then fused by RANK, which
 * discards magnitude outright, so the weak scope's rank-1 tied the strong
 * scope's rank-1 and displaced its rank-2 — frequently the answer. Measurement
 * across four repositories and four ecosystems put 73% of missed files in that
 * bucket. RRF is retained for `federateAsk` (see `graph/workspace.ts`), where
 * the corpora really are separate repositories and no shared denominator
 * exists — that is the case rank fusion is for.
 *
 * Soft federation: a scope whose top hit is probably an incidental word
 * collision, not a second home for the query, is left out of the combined order
 * and reported in `alsoMatched` instead, so the output can say "also matched:
 * docs/ — narrow with --in docs/" rather than diluting the pack. With
 * comparable scores that gate is simply {@link PARTICIPATION_RATIO} — a scope
 * must reach a real share of the best score anywhere in the repo. Under
 * per-scope normalization that check was vacuous (every scope's top was ~1.0),
 * which is why a separate match-STRENGTH gate ({@link STRONG_FLOOR}/{@link
 * HIGH_FLOOR}) had to stand in for it; that signal is still exported and still
 * used by `federateAsk`, which normalizes per child repo and therefore still
 * needs it.
 */
/** One scored document, attributed to the ranking scope (path prefix, "" =
 * root) it was scored within. Scores must be per-scope-normalized (each
 * scope's best ≈ its own ceiling) — fusion compares ranks, not raw scores. */
export interface ScopedDoc {
    id: string;
    scope: string;
    score: number;
}
/** Components preserved until immediately before comparable-scope combination.
 * Optional ranking experiments can adjust lexical evidence without having to
 * reconstruct it from the already blended scalar score. */
export interface ScopeRankCandidate extends ScopedDoc {
    /** Repo-global-normalized lexical component. */
    lexical: number;
    /** Scope-local normalized PPR component. */
    graph: number;
    /** Query-aware final multiplier, such as test-file de-ranking. */
    rankFactor: number;
}
export interface FusionResult {
    /** fused order, best first; carries per-doc scope label + fused score.
     * Normalized so the top MULTI-scope fused doc is 1 — but the single-scoring-
     * scope degenerate case passes ORIGINAL (pre-fusion) scores through
     * unchanged, and those are not guaranteed to fall in [0,1]. */
    ranked: {
        id: string;
        scope: string;
        score: number;
    }[];
    /** scopes that participated in fusion */
    federated: string[];
    /** scopes that matched weakly (≥1 scoring doc but below the participation gate) with their best doc */
    alsoMatched: {
        scope: string;
        bestId: string;
    }[];
}
/** RRF smoothing constant — the standard value from the original RRF paper;
 * high enough that rank 1 vs 2 differ gently rather than by 2×. */
export declare const RRF_K = 60;
/** A scope federates only when its best doc scores at least this share of the
 * global best — below it the match is reported, not fused. Used by
 * `fuseScopes`'s own internal gate (a post-normalization safety net once a
 * caller has already applied the real match-strength gate — see
 * {@link STRONG_FLOOR}/{@link HIGH_FLOOR}). */
export declare const PARTICIPATION_RATIO = 0.25;
/** The single source of truth for the cross-scope participation gate shared
 * by `rankScopesAndFuse` (single-graph multi-scope) and `federateAsk`
 * (workspace federation, `src/graph/workspace.ts`) — the two paths that solve
 * the identical "a weak scope must not federate beside a strong one" problem.
 * They MUST use the same floors so they can never drift into inconsistent
 * behavior again.
 *
 * A scope federates iff its top hit matched a query term in a NAME/PATH field
 * at all (any strength ≥ `STRONG_FLOOR`) — the primary gate. Well below every
 * genuine fixture (≥0.45) yet strictly above a body-only collision's 0, so a
 * real partial-relevance hit on a common/low-idf term is never overcorrected
 * out. */
export declare const STRONG_FLOOR = 0.1;
/** …OR the overall (name+path+body) coverage is broad enough to be real even
 * body-only. A single incidental body-token collision measures ~0.29 and RISES
 * with corpus size (0.30+ at 200 nodes) but never approaches this, while a
 * genuinely broad match clears it. This is why the gate is on absolute,
 * scale-invariant floors, NOT a raw-lexical-score ratio (which — calibrated for
 * raw-lexical-SCORE space — was far too lenient in coverage/matched-fraction
 * space and leaked junk, worsening as the corpus grew). */
export declare const HIGH_FLOOR = 0.5;
/**
 * Partition by scope, rank within scope (input scores are already
 * per-scope-normalized), gate by soft federation, fuse by RRF:
 * `fused(id) = Σ 1/(K + rank_in_scope(id))`, then normalized so the top fused
 * doc is 1. Non-scoring docs (score ≤ 0) are dropped entirely.
 *
 * Degenerate cases degrade to current behavior: zero scoring docs → empty
 * result; exactly one scoring scope → its docs pass through in score order
 * with their ORIGINAL scores (no RRF re-scoring, no gate) — byte-for-byte the
 * single-corpus ranking the caller would have produced anyway.
 */
export declare function fuseScopes(docs: ScopedDoc[]): FusionResult;
/**
 * Combine scopes whose scores are ALREADY comparable (shared corpus statistics
 * and a shared normalization denominator — see the module header). Same shape
 * and same gate as {@link fuseScopes}, but the combined order is read straight
 * off the score instead of from reciprocal rank, because with a common scale
 * the magnitude is exactly the signal rank fusion would throw away.
 *
 * Only {@link rankScopesAndFuse} may call this. `federateAsk` fuses separate
 * repositories, which have no common denominator, and must keep using
 * {@link fuseScopes}.
 */
export declare function combineComparableScopes(docs: ScopedDoc[]): FusionResult;
/** The per-scope scoring hooks `rankScopesAndFuse` drives — the caller owns
 * the actual lexical math and graph walk (they need its corpus state); this
 * module owns the orchestration so the shape of "rank per scope, then fuse"
 * lives in one place. */
export interface ScopeRankOps {
    /** Lexical scores for the scope's own docs (positive entries only), computed
     * against the REPO-WIDE corpus statistics. Per-scope statistics would make
     * the returned numbers incomparable between scopes, which is exactly the
     * defect in #117 — see the module header. */
    lex(scope: string): Map<string, number>;
    /** Does ANY scoring doc in this scope match a query term in its NAME or PATH?
     *
     * Serves ONE narrow purpose: suppressing a scope whose entire claim on the
     * query is prose. Score cannot catch that on its own — BM25 rewards a term
     * repeated in comments, so a file mentioning "gateway" thirty times in a
     * banner can outscore the class actually named `GatewayTimeout`.
     *
     * Deliberately evaluated over the whole scope, not just its top hit, and as a
     * presence check rather than a share threshold. Both choices are load-bearing:
     * a share of the whole query is unreachable for long queries (which is how the
     * old gate ended up admitting one scope and hiding the rest), and judging a
     * scope by its single best doc suppressed any scope whose top hit was a file
     * node — measured at 7.6 points of pooled R@10. */
    hasIdentifierMatch?(scope: string): boolean;
    /** Graph walk restricted to the scope's subgraph, seeded by that scope's
     * lexical scores; returns top-normalized centrality (or an empty map). */
    walk(scope: string, seeds: Map<string, number>): Map<string, number>;
    /** Optional query-aware multiplier applied after lexical normalization and
     * graph blending. Use this for priors (such as test-file de-ranking) that
     * normalization must not erase. */
    rankFactor?(scope: string, id: string): number;
    /** Optional candidate collapse after lexical + graph components are known
     * but before comparable scopes are gated and combined. File-aware ranking uses this
     * to supply exactly one real representative per file. The default path omits
     * the hook and remains byte-identical. */
    collapseCandidates?(candidates: readonly ScopeRankCandidate[]): readonly ScopedDoc[];
}
/**
 * Multi-scope orchestration for `ask`'s symbol ranking: for each scope, score
 * lexically (against the repo-wide statistics the caller supplies), walk the
 * scope's subgraph, blend exactly like the single-scope path (`lexN +
 * graphWeight·pr`, walk-rescued nodes joining above `rescueFloor`), then
 * combine the scopes with {@link combineComparableScopes}. A scope with zero
 * lexical matches contributes nothing (no seeds → no walk → no docs).
 *
 * The one thing that differs from the single-scope path: `lexN` divides by
 * `globalMaxLex`, the best raw lexical score across ALL scopes, rather than by
 * each scope's own best. That shared denominator is what makes the blended
 * scores comparable, and therefore what lets the combined order be read off the
 * score. Dividing per scope — as this did before #117 — pinned every scope's
 * top hit to ~1.0 regardless of how well it matched, which is the defect.
 *
 * Participation is then the {@link PARTICIPATION_RATIO} share check inside
 * {@link combineComparableScopes}: a scope must reach a real fraction of the
 * best score anywhere in the repo, else it is reported in `alsoMatched` for
 * `--in`. The match-STRENGTH floors ({@link STRONG_FLOOR}/{@link HIGH_FLOOR})
 * are no longer applied here — they existed to stand in for a share check that
 * per-scope normalization had made vacuous. `federateAsk` still normalizes per
 * child repo, so it still gates on strength; see `src/graph/workspace.ts`.
 */
export declare function rankScopesAndFuse(scopes: string[], ops: ScopeRankOps, graphWeight: number, rescueFloor: number): FusionResult;
//# sourceMappingURL=fuse.d.ts.map