import { type GrepResult } from "./grep.js";
export interface GrepCliOptions {
    ignoreCase?: boolean;
    fixed?: boolean;
    in?: string;
    json?: boolean;
    /** the top-level `--dir` override, so this command respects it like every other. */
    globalDir?: string;
}
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
/**
 * Resolve the graph at `dir` (respecting `--dir`), run `grepGraph`, and print
 * either the human report or `--json`. Exits the process (code 1) when
 * there's no graph at all or the pattern fails to compile as a regex — both
 * are caller-facing mistakes, not recoverable states. Zero hits is NOT an
 * error: it prints a loud note to stderr and exits 0.
 */
export declare function runGrepCommand(pattern: string, dir: string, opts: GrepCliOptions): void;
//# sourceMappingURL=grep-cli.d.ts.map