export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";
/** A contiguous run of changed lines, in POST-image (new file) line numbers. */
export interface LineRange {
    start: number;
    end: number;
}
/**
 * One line git reported inside a hunk.
 *
 * `n` is the POST-image number, so it is the number a reviewer sees in the file
 * on disk — a deleted line has none.
 */
export interface DiffLine {
    n: number | null;
    sign: "+" | "-";
    text: string;
}
/** A hunk's range and the lines in it. `ranges` on the file mirrors these. */
export interface Hunk extends LineRange {
    lines: DiffLine[];
    /** Lines dropped by the per-hunk cap — a generated file is not worth holding. */
    dropped: number;
}
export interface ChangedFile {
    /** Repo-relative posix path, post-image (the new name for a rename). */
    path: string;
    status: ChangeStatus;
    /** Pre-image path, renames only. */
    oldPath?: string;
    /** Post-image changed line ranges. Empty for a pure delete or a mode-only change. */
    ranges: LineRange[];
    /** The same hunks, carrying their text: what a panel shows so a reader sees the
     * change rather than a line number they have to go look up. One per range. */
    hunks: Hunk[];
}
export interface DiffResult {
    /** Human label for what was compared, e.g. "origin/main...HEAD". */
    basis: string;
    files: ChangedFile[];
}
/** True when `ref` names something git can resolve — checked before diffing so
 * an unknown `--base` fails with a caller-facing message, not a git stack. */
export declare function refExists(root: string, ref: string): boolean;
/**
 * Changed files + post-image line ranges.
 *
 * With no `base` this reports the working tree against HEAD (the local
 * "what am I about to push" case), falling back to the last commit when the
 * tree is clean — so the command answers something useful when run by hand,
 * and CI passes `--base` for the real PR range.
 */
export declare function changedFiles(root: string, base?: string): DiffResult | null;
//# sourceMappingURL=diff.d.ts.map