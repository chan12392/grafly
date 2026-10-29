import { type GrepResult } from "./grep.js";
/** `"<pattern>" — N hits in M symbols across K files (searched T indexed files)` */
export declare function formatGrepHeader(result: GrepResult): string;
/** Full human report: header, blank line, then one block per group (header +
 * indented hit lines), each block separated by a blank line. */
export declare function formatGrepResult(result: GrepResult): string;
/** Loud, actionable zero-hit note (never a bare empty result) — printed to
 * stderr; the caller still exits 0, since "no hits in the indexed graph" is
 * not an error, just a reason to fall back to a real grep.
 *
 * Truncation is never silent, even on the zero-hit path: if some indexed
 * files couldn't be read (`truncated.files > 0`), that's called out too —
 * otherwise a zero-hit result on a stale graph or wrong root reads as "no
 * matches" when really some files were never searched at all. */
export declare function zeroHitNote(result: GrepResult): string;
