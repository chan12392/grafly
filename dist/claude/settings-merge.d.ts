type Json = Record<string, any>;
/**
 * Is this allowlist entry one graft wrote?
 *
 * Scoped to the forms graft is actually invoked as — NOT any rule mentioning
 * "graft". A user who allowlists their own `Bash(graft-mytool:*)` keeps it; only
 * graft's own set is replaced, which is what lets a renamed entry disappear on
 * upgrade instead of accumulating beside its replacement.
 */
export declare function isGraftAllowEntry(entry: unknown): boolean;
/** Is this footer regex graft's? It points at the card tree, which is graft's alone. */
export declare function isGraftFooterRegex(re: unknown): boolean;
/** True when init should write (or refresh) Graft's Claude Code statusLine. */
export declare function statuslineWanted(opts?: {
    statusline?: boolean;
}): boolean;
export declare function mergeGraftSettings(existing: Json, opts?: {
    statusline?: boolean;
}): {
    merged: Json;
    warnings: string[];
};
/**
 * The hook blocks alone, merged into a settings file, with the shims addressed by
 * absolute path — `~/.claude/settings.json`, where a write reaches every project on
 * the machine (see hosts/claude-global.ts for why that copy has to exist).
 *
 * Hooks only, deliberately. `mergeGraftSettings` also claims the statusline, the
 * footer regex and a Bash allowlist, and each of those is a reasonable thing to
 * accept for a repo you ran `graft init` in and an unreasonable thing to impose on
 * every repo you ever open — a statusline especially, since a session allows exactly
 * one and taking it globally would silently outrank the user's own. The hooks are the
 * piece that has to be global, because they are what a worktree loses.
 *
 * Same idempotent shape as the repo merge: graft's prior entries are dropped before
 * the current set is added, so re-running converges instead of stacking.
 */
export declare function mergeGraftHooks(existing: Json, helpers: string): {
    merged: Json;
};
export {};
//# sourceMappingURL=settings-merge.d.ts.map