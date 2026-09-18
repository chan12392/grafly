/** Every extension graft has a parser for (depth + breadth + container), sorted
 * and de-duped — the authoritative answer to "what does `-e` actually support". */
export declare function supportedExtensions(): string[];
/**
 * The subset of user-supplied `-e` extensions that no parser claims (depth or breadth).
 * `graft build -e ".vue"` used to accept these silently and index nothing; the CLI warns
 * on whatever this returns so an unsupported extension is never a quiet no-op.
 */
export declare function unsupportedExtensions(exts: string[]): string[];
/**
 * The source files a graph build parses: supported languages, minus the
 * output dir. When no pre-enumerated `repoFiles` is passed, the walk reads
 * `root`'s persisted file-walk choices directly from state, so every caller
 * that enumerates through here (the fingerprint probe and hooks/refresh path,
 * none of which ever see a CLI flag) behaves identically to the build that
 * saved those choices.
 */
/** Keep only files whose repo-relative path is at or under one of `onlyDirs`.
 * No-op when `onlyDirs` is empty/absent. The whitelist is carried in the graph
 * itself (the fingerprint records it at build time), never in the source repo,
 * so a build and the query-path freshness probe read the identical set. */
export declare function filterByOnlyDirs(files: string[], root: string, onlyDirs?: ReadonlySet<string>): string[];
export declare function listSourceFiles(root: string, outDir: string, repoFiles?: string[], onlyDirs?: ReadonlySet<string>): string[];
export interface SourceStat {
    /** Absolute path. */
    abs: string;
    /** Repo-relative, posix (`relPosix`) — exactly the form `buildGraph` uses for
     * node ids and `checkGraph` diffs against, so cache keys and ids can never
     * disagree. Posix on every platform: see `../util/paths.ts`. */
    rel: string;
    size: number;
    mtimeMs: number;
}
/**
 * {@link listSourceFiles} plus each file's `(size, mtimeMs)` — the currency of
 * both the freshness probe and the extraction cache. Files that vanish between
 * the walk and the stat are dropped (same fail-soft posture as `walkDir`).
 */
export declare function listSourceStats(root: string, outDir: string, repoFiles?: string[], onlyDirs?: ReadonlySet<string>): SourceStat[];
//# sourceMappingURL=source-files.d.ts.map