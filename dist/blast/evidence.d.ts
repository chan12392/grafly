import type { Evidence } from "../viz/assemble.js";
import type { Impacted, Seed } from "./blast.js";
import type { ChangedFile } from "./diff.js";
/** Symbols given their own snippet per node. Past this the panel is a file listing
 * rather than a summary — the rest are still counted in the headline. */
export declare const MAX_EVIDENCE = 4;
/** `L12-L34` → the numbers, so a label is something a reader can type. */
export declare function spanRange(span: string): {
    start: number;
    end: number;
} | null;
/** Evidence for one changed symbol: what this PR did to it. */
export declare function seedEvidence(seed: Seed, file: ChangedFile | undefined): Evidence | null;
/**
 * The first line inside a span that mentions one of `needles`, with its number.
 *
 * This is the whole trick behind "why is this symbol here": the edge says A calls
 * B, and this finds the line where it does it. Shared so `blast`'s panel, its
 * comment and `graft callers` all quote the same line for the same edge.
 */
export declare function referenceLine(path: string, span: string, needles: RegExp[], read: (path: string) => string[] | null): {
    n: number;
    text: string;
} | null;
/** A symbol name, matched as a whole word — `export` must not hit `exportViz`. */
export declare const wordRe: (name: string) => RegExp;
/**
 * Evidence for one dependent symbol: the line that reaches the diff.
 *
 * Nothing changed here, so there is no hunk to show — the useful line is the one
 * naming a changed symbol or module, which answers "why am I in this blast radius
 * at all". Found by reading the symbol's span off disk.
 *
 * When no line names the diff, this returns nothing rather than quoting the span's
 * first line: for a file-level dependent that first line is `/**`, and a panel that
 * shows it has spent a code block to say nothing.
 */
export declare function impactedEvidence(sym: Impacted, reach: ReachTerms, read: (path: string) => string[] | null): Evidence | null;
/** What a line has to mention to be the line that reaches the diff. */
export interface ReachTerms {
    /** Changed symbol names, longest first. */
    names: string[];
    /** `from "./data.js"` for each changed file, matched on the module specifier so
     * a common stem like `data` cannot match a variable of the same name. */
    modules: RegExp[];
}
export declare function reachTerms(seeds: Seed[], changed: ChangedFile[]): ReachTerms;
/** Read each file once, and never fail: a snippet is a nicety, and a symbol whose
 * file moved under us must not take the whole page down. */
export declare function fileReader(root: string | undefined): (path: string) => string[] | null;
//# sourceMappingURL=evidence.d.ts.map