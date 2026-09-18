import type { Stats, SessionState } from './state.js';
import type { GraphV1, EdgeV1 } from '../graph/types.js';
export declare function freshnessSegment(s: Stats): string;
export declare function renderStatusline(stats: Stats | null, session: SessionState | null, ctx: {
    ctxPct: number | null;
}): string[];
export declare function incomingEdges(w: GraphV1, filePath: string): EdgeV1[];
export declare function formatBlastRadius(w: GraphV1, filePath: string, cap?: number): string | null;
export interface AskJson {
    query: string;
    mode: string;
    hits: {
        kind: string;
        title: string;
        pointer: string;
        snippet: string;
        score: number;
        code?: string;
    }[];
    /** Set by `ask --source`: whole size of the files these hits cover (baseline). */
    saved?: {
        files: number;
        baselineChars: number;
    };
    /** Lexical mode: share (0..1) of the query's distinct terms the top hit matched. */
    coverage?: number;
    /** Lexical mode: the same share over the top hit's NAME field only — "did the
     * query hit a real symbol, or only words buried in some body?". `ask --json`
     * has always emitted it; the gate below is what finally reads it. */
    coverageStrong?: number;
}
/** Tokens saved (baseline − this pack), or 0 when no honest estimate applies. */
export declare function retrievalTokensSaved(ask: AskJson, cap?: number): number;
export declare function formatRetrieval(ask: AskJson, cap?: number): string | null;
/**
 * Superseded by the two-clause strength gate in {@link relevantRetrieval} (see
 * {@link STRONG_FLOOR} / {@link HIGH_FLOOR}). Kept exported because the old
 * single-clause floor is still the documented reference point for why it changed:
 * it sat at 0.15, and a prompt measuring 0.165 / strong 0.033 cleared it by 0.015
 * and injected three test files for a question whose answer was elsewhere. The
 * comment it used to carry justified leaning low — "a wrongly-skipped pack is
 * recoverable, the agent pulls with `graft ask`" — and that assumption is exactly
 * what a traced session falsified: the agent did not pull. It grepped 38 times.
 */
export declare const INJECT_MIN_COVERAGE = 0.15;
/** How many weak-match nudges one session may spend. A line that shows up every
 * turn stops being read; two is enough to land the habit without becoming
 * wallpaper. */
export declare const NUDGE_CAP = 2;
/** The line injected instead of a weak pack: names the command, says why, once.
 * Deliberately not an imperative about graft in general — it's a fact about this
 * prompt's match quality plus the command that fixes it. */
export declare function weakMatchNudge(s: SessionState, strong: number): string | null;
/**
 * The per-prompt injection gate. Returns the text to inject, or null to stay
 * silent. Mutates `s` to remember what was shown (caller persists it).
 *
 * Gate 1 — **strength**. A pack earns its place only if the top hit either landed
 * on a real symbol NAME (`coverageStrong ≥ STRONG_FLOOR`) or matched the query
 * broadly enough to trust regardless (`coverage ≥ HIGH_FLOOR`). This is the same
 * two-clause rule `fuse.ts` already uses to decide whether a whole sub-repo joins
 * a cross-repo ranking — a cheaper decision than this one, previously held to a
 * stricter standard. Failing it emits {@link weakMatchNudge} rather than nothing:
 * silence leaves the agent with no signal at all, and a borderline pack is worse
 * than either, because it reads as orientation and suppresses the very retrieval
 * call it should have triggered. Structural results carry neither score — the
 * resolved intent is itself the relevance signal — so they always pass.
 *
 * Gate 2 — **novelty**. Hits whose pointer was already injected this session are
 * dropped; if none remain, the pack is skipped.
 */
export declare function relevantRetrieval(ask: AskJson, s: SessionState, cap?: number): string | null;
export declare function formatOrientation(indexMd: string, budgetBytes?: number, staleNote?: string): string;
export declare function renderSubagent(agentName: string, session: SessionState | null): string;
//# sourceMappingURL=format.d.ts.map