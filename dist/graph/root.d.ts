/** True when `dir` is a graft root of either shape — a built repo or a workspace parent. */
export declare function hasGraftIndex(dir: string): boolean;
export interface RootResolution {
    /** Absolute dir to run the command against. */
    root: string;
    /** Directory levels walked up; 0 when the start dir was already the root (the common case). */
    levels: number;
}
/** The nearest ancestor of `start` (inclusive) that holds a graft index, else `start`. */
export declare function nearestGraftRoot(start: string, override?: string): RootResolution;
//# sourceMappingURL=root.d.ts.map