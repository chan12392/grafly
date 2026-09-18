export interface Stats {
    nodeCount: number;
    edgeCount: number;
    languages: string[];
    totalCount: number;
    readyCount: number;
    staleCount: number;
    dirty: boolean;
    syncing: boolean;
    syncedAt: string | null;
    lastFile: string | null;
}
export declare const LOCK_STALE_MS = 300000;
export declare function emptyStats(): Stats;
/**
 * Where the pieces this module manages (the stats cache, the sync lock,
 * per-session state, the upkeep stamp) actually live when no caller-supplied
 * override is available. The Claude Code hooks, `sync-run`, the statusline,
 * and `upkeep` all resolve a bare project dir and never see an explicit
 * `--dir` — unlike a direct CLI invocation, which threads one through
 * `contextDirFor` (`context/node-file.ts`). This mirrors that same override
 * precedence for those entry points: `GRAFT_DIR` wins over the default
 * `<projectDir>/graft`, the same env var `resolveConfig` already honors for
 * the `--deep` LLM path. A relative `GRAFT_DIR` resolves against `projectDir`
 * so it holds regardless of the caller's cwd.
 */
export declare function resolveContextDir(projectDir: string): string;
export declare function cacheDir(projectDir: string): string;
export declare function readJson<T>(p: string): T | null;
/**
 * Write JSON to `p` via a scratch file and a rename, so a concurrent reader sees
 * either the whole old file or the whole new one — never a truncated prefix. The
 * pid in the temp name keeps two concurrent writers off each other's scratch file.
 *
 * `compact` drops the indentation, for the caches only a machine ever opens —
 * it's ~30% of the bytes on a big, deep object.
 *
 * A failed write takes its scratch file with it. Every CLI invocation is a new pid,
 * so the names never collide and never get reused: leaving them behind means a repo
 * that fails this write repeatedly (ENOSPC, or a Windows indexer holding the target
 * open) accumulates one full-size file per attempt, and nothing in graft ever lists
 * `.cache/` to clean them up.
 */
export declare function writeJsonAtomic(p: string, value: unknown, compact?: boolean): void;
export declare function readStats(d: string): Stats | null;
export declare function writeStats(d: string, s: Stats): void;
/**
 * Persisted per-repo build configuration. Explicit CLI choices live here so
 * later no-flag builds and automatic refreshes enumerate the same file set.
 * Missing fields always retain backwards-compatible defaults.
 */
export interface BuildConfig {
    /** SKIP_DIRS names to include in this repo's walks, persisted so a LATER
     * no-flag build — and the fingerprint/refresh path, which never sees CLI
     * flags at all — behave identically to the invocation that set it. */
    includeDirs?: string[];
    /** Whether initialized Git submodules (gitlinks) are folded into this repo's
     * graph. Absent/false keeps the historical boundary at the superproject. */
    followSubmodules?: boolean;
    /** Whether nested Git clones the index does not track — how manifest-driven
     * multi-repo tools check dependencies out, and how an ad-hoc local clone lands
     * in the tree — are folded into this repo's graph. Deliberately SEPARATE from
     * `followSubmodules`: a submodule is a dependency the parent pins, a nested
     * clone is invisible to the parent's index and may equally be a scratch
     * checkout someone parked in the tree. Absent/false keeps the historical
     * boundary. */
    followNestedRepos?: boolean;
    /** The Trail brain this repo's rules come from: the brain id and the token to
     * read it with. Persisted here — in the git-ignored `.graft/` — rather than in
     * `~/.graft/`, because a brain belongs to one repository and two checkouts on
     * one machine must not share one. `undefined` clears it. */
    brain?: {
        brainId: string;
        token: string;
        baseUrl?: string;
    };
}
/** Local, Git-ignored repository configuration. Kept outside generated
 * `graft/` output so deleting/replacing that cache, workspace federation, and
 * custom `--dir` builds cannot erase or redirect the persisted choice. */
export declare const BUILD_CONFIG_DIR = ".graft";
export declare function buildConfigPath(d: string): string;
export declare function readBuildConfig(d: string): BuildConfig | null;
export declare function writeBuildConfig(d: string, c: BuildConfig): void;
/** Merge explicit CLI choices into the existing local config, so updating one
 * persisted build option cannot erase another. */
export declare function patchBuildConfig(d: string, patch: BuildConfig): void;
/** The persisted `--include-dir` override for repo `d`, as a Set — `undefined`
 * when nothing was ever persisted (or the persisted list is empty), which every
 * `shouldSkipDir`/`walkDir` caller treats as "today's default behavior". Shared
 * by every walkDir-driven entry point (source-files.ts, scopes.ts) so a build,
 * a later no-flag rebuild, and the hooks/refresh path all agree. */
export declare function readIncludeDirs(d: string): Set<string> | undefined;
/** Missing and explicit false both retain the backwards-compatible default. */
export declare function readFollowSubmodules(d: string): boolean;
/** Missing and explicit false both retain the backwards-compatible default. */
export declare function readFollowNestedRepos(d: string): boolean;
export declare function patchStats(d: string, patch: Partial<Stats>): Stats;
export declare function acquireLock(d: string): boolean;
export declare function releaseLock(d: string): void;
/**
 * The lock, addressed by cache dir rather than project dir. For the default layout
 * `<root>/graft/.cache` these are the same file, which is the point: the Claude Code
 * hooks lock by project dir and the graph's auto-refresh locks by the context dir it
 * is actually writing, and the two must collide so they can't rebuild at once.
 */
export declare function acquireLockIn(cache: string): boolean;
export declare function releaseLockIn(cache: string): void;
//# sourceMappingURL=state.d.ts.map