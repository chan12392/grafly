export type BlastFormat = "text" | "markdown" | "mermaid" | "json";
export interface BlastCliOptions {
    /** Base ref to diff against (`origin/main`); omitted → working tree vs HEAD. */
    base?: string;
    /** Raw `--depth`: a positive integer, or `all`/`full`/`max`. Default 2. */
    depth?: string;
    format?: string;
    /** Ask a model to name the clusters that have no concept name (one call, cached).
     * Opt-in: a local `graft blast` must not need a key or a network round-trip. */
    name?: boolean;
    /** Write the interactive page for this radius here (one self-contained file). */
    exportViz?: string;
    /** Subtitle beside the repo name on the exported page, e.g. "PR #171". Same
     * meaning as `graft viz --title`. Without it a reader of a published page has no
     * way to tell which pull request they are looking at. */
    title?: string;
    /** Suggest who to tag, from git history over each area. On by default; `--no-owners`
     * turns the whole layer off for a repo that would rather not name people. */
    owners?: boolean;
    /** The PR author: logins, names or emails to keep out of their own suggestions. */
    prAuthor?: string[];
    /** The top-level `--dir` override. */
    globalDir?: string;
}
export declare function runBlastCommand(dir: string, opts: BlastCliOptions): Promise<void>;
/**
 * What to call the repository in the appbar.
 *
 * `basename(root)` is right for someone running this in their own clone, but CI
 * checks a pull request out into a directory named for the job — ours is literally
 * `pr` — which titled the published page "pr". The origin remote is the repository,
 * so it wins when there is one; a detached tarball checkout still falls back.
 */
export declare function repoLabel(root: string): string;
//# sourceMappingURL=blast-cli.d.ts.map