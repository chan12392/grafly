/** Where a write lands. 'global' = outside the repo, affects every project. */
export type WriteScope = 'repo' | 'global';
export interface PlannedWrite {
    /** The selectable host this write belongs to ('claude', 'agents', 'cursor', …). */
    hostId: string;
    /** Reporting id — differs from hostId where one host writes several configs
     *  (the 'agents' host covers both 'codex' and 'opencode'). */
    id: string;
    path: string;
    scope: WriteScope;
    kind: 'instruction' | 'mcp' | 'hook' | 'claude' | 'skill';
    /** Short human label for what changes in that file. */
    what: string;
}
export interface HostPlan {
    id: string;
    name: string;
    detected: boolean;
    writes: PlannedWrite[];
}
/**
 * Every host graft can wire, each with the full set of files selecting it would
 * touch. Claude Code comes first — it's the deep integration and the picker's
 * default. `ids`, when given, restricts the plan to those hosts.
 */
export declare function planInit(repo: string, opts?: {
    home?: string;
    ids?: string[];
}): HostPlan[];
/** Flatten a plan down to the writes for the selected host ids. */
export declare function selectedWrites(plan: HostPlan[], ids: string[]): PlannedWrite[];
//# sourceMappingURL=plan.d.ts.map