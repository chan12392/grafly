import type { WriteScope } from './plan.js';
/** What a retraction did to one target. */
export type RetractAction = 
/** graft's contribution was there and is now gone. */
'removed'
/** the whole file was graft's, so the file itself is gone. */
 | 'deleted'
/** nothing of graft's here. */
 | 'absent'
/** file exists but can't be parsed — left untouched rather than risk it. */
 | 'skipped-unparseable';
export interface Retraction {
    /** The host this target belongs to, for grouping the report. */
    hostId: string;
    path: string;
    /** Short human label for what was removed from that file. */
    what: string;
    scope: WriteScope;
    action: RetractAction;
}
export interface RetractOpts {
    home?: string;
    /** false → report only, touch nothing. Defaults to false: a destructive
     *  operation must be asked for, never assumed. */
    apply?: boolean;
    /** false → skip targets outside the repo (the ~/.codex and ~/.gemini writes). */
    global?: boolean;
    /** false → keep `graft/` and the ignore entries. `init` sets this: the cache is
     *  regenerable but re-parsing a large repo costs minutes, and init is about to
     *  use it. */
    cache?: boolean;
    /** Host ids about to be re-written, so their targets are left alone. `init`
     *  passes its selection: retracting a file it is one step from rewriting is
     *  pure churn (and would report every write as `created`). */
    exclude?: string[];
}
/** What a retraction *would* remove. Pure — touches nothing. */
export declare function planRetract(repo: string, opts?: RetractOpts): Retraction[];
/**
 * Remove graft's contribution from every target. Reports every target it
 * considered, including the ones that were already clean, so a caller can show
 * either the full sweep or just what changed.
 */
export declare function runRetract(repo: string, opts?: RetractOpts): Retraction[];
/** The subset worth showing a user: targets that had something to remove. */
export declare function changed(retractions: Retraction[]): Retraction[];
//# sourceMappingURL=retract.d.ts.map