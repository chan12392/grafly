export interface CheckResult {
    ok: boolean;
    /** True when there is no graph at all (init has never run). */
    missing: boolean;
    contentDrift: Array<{
        path: string;
        from: string;
        to: string;
    }>;
    removed: string[];
    coverage: string[];
    indexDrift: string[];
}
export interface CheckOptions {
    contextDir?: string;
    extensions?: string[];
}
export declare function checkContext(dir: string, opts?: CheckOptions): CheckResult;
/** A cheap, query-time staleness signal (unlike {@link checkContext}, which
 * re-hashes every file for CI). */
export interface FreshnessResult {
    /** Recorded source files that are no longer on disk. */
    missing: number;
    /** Total source files the manifest recorded. */
    total: number;
}
/**
 * How many recorded source files have vanished from disk — an existence-only
 * check (stat, never a read or a hash), safe to call on a hot path like session
 * start. This catches the common "index built on a different tree" case: a
 * branch switch, a `git checkout` to an older commit, an unpulled move — states
 * where graft would otherwise confidently point at files that aren't there and
 * send the agent chasing them. Returns null when there's no graph at all.
 */
export declare function indexFreshness(dir: string, opts?: CheckOptions): FreshnessResult | null;
/** One-line staleness banner for orientation/query output, or null when the
 * index is fresh (or absent). Terse on purpose — it rides atop the orientation
 * the agent reads first, so it must earn its tokens. */
export declare function staleBanner(f: FreshnessResult | null): string | null;
/** Render a check result as a human-readable report. */
export declare function formatCheckReport(r: CheckResult): string;
//# sourceMappingURL=check.d.ts.map