export declare const START = "<!-- graft:start -->";
export declare const END = "<!-- graft:end -->";
/**
 * A brain's rules go in their OWN fenced block, not inside the instruction
 * block above.
 *
 * They have to be separately addressable: the instruction body is static and
 * rewritten by `init`, while rules change whenever the brain does and are
 * refreshed on their own. One pair of markers for both would mean every rules
 * refresh rewrites the instructions too, and `graft uninstall` could not remove
 * one without the other.
 */
export declare const BRAIN_START = "<!-- graft:brain:start -->";
export declare const BRAIN_END = "<!-- graft:brain:end -->";
/** One addressable managed region in a file the user owns. */
export interface Markers {
    start: string;
    end: string;
}
export declare const GRAFT_MARKERS: Markers;
export declare const BRAIN_MARKERS: Markers;
/** Every managed region graft may own in a user-owned file. */
export declare const ALL_MARKERS: Markers[];
export type UpsertAction = 'created' | 'appended' | 'replaced' | 'unchanged';
type LineEnding = '\n' | '\r\n';
export declare function fencedBlock(body: string, eol?: LineEnding, markers?: Markers): string;
export declare function upsertSection(filePath: string, body: string, markers?: Markers): {
    action: UpsertAction;
};
export {};
//# sourceMappingURL=sections.d.ts.map