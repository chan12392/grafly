export interface UpkeepResult {
    /** Lines worth showing the agent/user, already formatted. Usually empty. */
    lines: string[];
}
/**
 * @param repo    the project dir
 * @param current the running graft's version
 * @param opts.background  false in hook contexts: read the update cache, never
 *   spawn a fetch. Hooks run under a hard timeout and must stay off the network.
 */
export declare function runUpkeep(repo: string, current: string, opts?: {
    background?: boolean;
    home?: string;
}): UpkeepResult;
//# sourceMappingURL=upkeep-run.d.ts.map