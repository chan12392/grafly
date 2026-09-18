/** Env kill switch, mirroring `GRAFT_NO_REFRESH` in ./refresh.ts. */
export declare function seedDisabled(): boolean;
/**
 * The main checkout of the repo `root` is a linked worktree of, or null when `root`
 * isn't one (which is the common case, and not an error).
 *
 * Filesystem-only on purpose: no `git` subprocess on a path that runs before every
 * query. The shapes it has to tell apart:
 *
 * - `<root>/.git` is a **directory** → this *is* the main checkout. Nothing to seed.
 * - `gitdir: <main>/.git/worktrees/<name>` → a linked worktree. `commondir` inside
 *   that dir points back at the shared `.git` (`../..`), whose parent is the main
 *   checkout.
 * - `gitdir: <super>/.git/modules/<name>` → a **submodule**. Identical file shape,
 *   completely different thing: a submodule is its own repo and its parent's `graft/`
 *   describes different code entirely. The `worktrees` path segment is what rejects it.
 * - A bare repo or `--separate-git-dir` layout, where the resolved common dir isn't
 *   named `.git` and there may be no working tree at all → null.
 */
export declare function mainWorktreeRoot(root: string): string | null;
export interface SeedResult {
    seeded: boolean;
    /** The main checkout the graph came from, when one was used. */
    from?: string;
}
/**
 * Copy the parent checkout's graph into `root`'s own `graft/`, if all of this holds:
 * `root` is a linked worktree, it has no graph yet, the parent has one, and no `--dir`
 * override is in play (a custom output dir can't be mapped to a sibling checkout —
 * the same conservatism `ensureGitignored` applies).
 *
 * Best-effort by contract: the caller's fallback is the behaviour that existed before
 * this function did, so every failure returns `{ seeded: false }` rather than raising.
 */
export declare function seedGraph(root: string, opts?: {
    contextDir?: string;
}): SeedResult;
//# sourceMappingURL=seed.d.ts.map