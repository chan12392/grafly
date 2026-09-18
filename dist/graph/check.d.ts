export interface GraphCheckResult {
    ok: boolean;
    /** True when there is no graph.json (a graph has never been built). */
    missing: boolean;
    added: string[];
    removed: string[];
    changed: string[];
    stale: string[];
    /** Nodes never summarized (reported for context; not counted as drift). */
    pending: number;
    /** Ids of pending nodes (capped when formatting) — so a stuck meaning pass
     * names the files instead of only saying "run --deep" (#172). */
    pendingIds: string[];
    /** Committed nodes in total — the denominator that turns `pending` into a
     * coverage figure. A deep build that lost most of its LLM calls (#127) is only
     * distinguishable from a deliberate Tier-1 build by the SHARE that is missing. */
    nodes: number;
}
export interface GraphCheckOptions {
    contextDir?: string;
}
export declare function checkGraph(dir: string, opts?: GraphCheckOptions): Promise<GraphCheckResult>;
/** Render a graph-check result as a human-readable report. */
export declare function formatGraphCheckReport(r: GraphCheckResult): string;
//# sourceMappingURL=check.d.ts.map