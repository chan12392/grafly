/**
 * Pure bounded file ranking.
 *
 * Binary IDF coverage supplies a bounded residual to one raw-lexical anchor.
 * Every other real candidate keeps its exact baseline score, and PageRank is
 * never recomputed or amplified by a file-level multiplier.
 */
export interface FileRankCandidate {
    id: string;
    /** Exact repository-relative source path. */
    file: string;
    /** Residual module node, or an exact symbol span. */
    kind: "file" | "symbol";
    /** Existing raw lexical score, before the shared normalization denominator. */
    rawLexical: number;
    /** Existing normalized lexical component, expected in [0, 1]. */
    lexical: number;
    /** Existing normalized PPR component, expected in [0, 1]. */
    graph: number;
    /** Existing query-aware final multiplier (for example test de-ranking). */
    rankFactor: number;
    /** Exact current score, retained for every non-winning candidate. */
    baselineScore: number;
    /** Existing final-list tie key. When present, equal-score candidates keep
     * the caller's baseline ordering before file-specific fallbacks apply. */
    baselineTieKey?: string;
    /** Exact query terms that the existing lexical scorer awarded to this node. */
    matchedTerms: ReadonlySet<string>;
    /** Query terms matched in the symbol NAME field only. File/residual nodes
     * leave this empty so workspace strength gating cannot be cleared by a
     * coincidental filename or body token. */
    matchedStrongTerms?: ReadonlySet<string>;
    /** Only real lexical symbol spans may donate complementary evidence. */
    eligible: boolean;
    /** Deterministic anchor/queue tie-break inputs. */
    emittedTokens?: number;
    spanStart?: number;
}
export type FileRepresentativeReason = "pooled-anchor" | "baseline-symbol" | "baseline-residual";
export interface RankedFile {
    file: string;
    /** Concrete existing node that owns the returned file score. */
    representative: FileRankCandidate;
    representativeReason: FileRepresentativeReason;
    /** Raw-lexical symbol that alone may receive the bounded residual. */
    lexicalAnchor?: FileRankCandidate;
    /** Existing candidates in deterministic baseline order, representative first. */
    queue: FileRankCandidate[];
    unionCoverage: number;
    unionStrongCoverage: number;
    anchorCoverage: number;
    /** A_F * (U_F - A_F) / U_F. */
    boundedResidual: number;
    pooledLexical: number;
    lexicalDelta: number;
    score: number;
}
/**
 * Rank exact files using the bounded anchor formula:
 *
 *   a_F = argmax rawLexical among eligible lexical symbols
 *   A_F = coverage(a_F)
 *   U_F = union coverage of eligible lexical symbols
 *   r_F = A_F (U_F - A_F) / U_F
 *   P_F = d_a [ell_a + (1 - ell_a) r_F + 0.5 p_a]
 *   S_F = max(P_F, max_j baseline_j)
 *
 * The anchor is the only pooled candidate. Graph-only symbols, residual nodes,
 * and all other lexical symbols remain exact baseline competitors.
 */
export declare function rankFilesBounded(candidates: readonly FileRankCandidate[], queryWeights: ReadonlyMap<string, number>): RankedFile[];
//# sourceMappingURL=file-rank.d.ts.map