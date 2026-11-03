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
    /** Suggest who to tag, from git history over each area. On by default; `--no-owners`
     * turns the whole layer off for a repo that would rather not name people. */
    owners?: boolean;
    /** The PR author: logins, names or emails to keep out of their own suggestions. */
    prAuthor?: string[];
    /** The top-level `--dir` override. */
    globalDir?: string;
}
export declare function runBlastCommand(dir: string, opts: BlastCliOptions): Promise<void>;
