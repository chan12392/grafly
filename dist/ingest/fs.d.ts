/** Directories that are dependency/build output, never source. */
export declare const SKIP_DIRS: Set<string>;
/** Files above this size are generated/vendored in practice, not hand-written code. */
export declare const MAX_FILE_BYTES = 1000000;
/**
 * Whether a directory named `name` should be skipped when walking a repo tree:
 * any dot-prefixed directory (`.git`, `.github`, `.vscode`, ...) or one of
 * {@link SKIP_DIRS} not named in `includes`. The single source of truth for
 * "is this dir source" — `skippedPath` and `walkFilesystem` below and the
 * git-child discovery in `graph/scopes.ts` share it, so they can never
 * independently drift on what counts as skippable.
 *
 * `includes` is the explicit, per-repo `graft build --include-dir` override
 * (persisted via `util/state.ts`'s `readIncludeDirs`, threaded in by each
 * caller) — a name in it is removed from the effective skip set for THIS
 * repo's walks. Absent/empty ≡ today's default behavior. It lifts only
 * graft's own skip list: in a Git repo, Git's ignore rules stay authoritative
 * (see {@link walkDir}).
 *
 * KNOWN LIMITATION: a dot-directory is skipped WHOLESALE and is NEVER
 * overridable, even via `includes` — unlike `SKIP_DIRS`, there is no path to
 * un-skip one. A repo that keeps real, hand-written source under a
 * dot-prefixed directory is out of scope.
 */
export declare function shouldSkipDir(name: string, includes?: ReadonlySet<string>): boolean;
/**
 * Recursively list all files under a directory. Skips dot-directories,
 * dependency/build directories (node_modules, dist, …) not named in
 * `includes`, and files over 1 MB.
 * In a Git worktree, tracked files plus untracked, non-ignored files come from
 * `git ls-files`; this gives indexing exactly Git's nested `.gitignore`,
 * negation, and global-exclude semantics. Non-Git directories retain the plain
 * filesystem walk. `includes` lifts only the built-in skip list — it never
 * overrides Git's ignore rules (un-ignore or `git add -f` a directory to
 * index it, the same contract as tracked-but-ignored files).
 *
 * Two INDEPENDENT opt-ins cross the repository boundary, because Git models two
 * different relationships and only one of them is a dependency the parent pins:
 *
 *   - `followSubmodules` follows a GITLINK — an index entry with mode `160000`,
 *     a commit the superproject versions.
 *   - `followNestedRepos` follows a nested clone the parent's index knows
 *     nothing about. Manifest-driven multi-repo tools (west, repo, gclient,
 *     tsrc, mr, …) all check dependencies out this way, and so does anyone who
 *     clones an upstream into the tree to patch it locally.
 *
 * Both default to false, preserving the historical superproject boundary. Each
 * child keeps its own ignore rules; uninitialized submodules and gitignored
 * nested clones remain absent either way (`--exclude-standard` never emits
 * them, so there is nothing to follow).
 */
export interface WalkOptions {
    /** Include initialized Git submodules (gitlinks) recursively. Default false. */
    followSubmodules?: boolean;
    /** Include nested Git clones the parent index does not track. Default false. */
    followNestedRepos?: boolean;
}
/**
 * Directory `walkDir` actually enumerates.
 *
 * `path.resolve` does not follow a symlink, and git discovers the repo from the
 * child cwd. Unwrap a symlink-to-directory once so the walk runs inside the
 * target. Ordinary directories stay as `resolve(dir)` — not `realpath` — so a
 * macOS `/var/folders/…` scratch path is the path the caller handed us.
 *
 * A broken symlink throws instead of the `scandir ENOENT` `readdirSync` would
 * raise after git fails. Internal symlink policy is not decided here.
 */
export declare function canonicalWalkRoot(dir: string): string;
/**
 * Recursively list source files under `dir`. A directory symlink as the *input
 * root* is unwrapped once ({@link canonicalWalkRoot}); emitted paths are remapped
 * onto the caller-facing root so `relPosix` stays `src/foo.ts` rather than a
 * `../` escape through the physical path (macOS `/tmp` → `/private/tmp`).
 * Symlinks *inside* the tree are not followed: git still `lstat`s each listed
 * path, and the filesystem walk still requires `Dirent.isFile` / `isDirectory`.
 */
export declare function walkDir(dir: string, includes?: ReadonlySet<string>, opts?: WalkOptions): string[];
//# sourceMappingURL=fs.d.ts.map