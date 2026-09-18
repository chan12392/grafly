/**
 * The version of the graft package this code was loaded from.
 *
 * Resolved from *this* module rather than the caller's: `readCurrentVersion`
 * looks one level up from the module URL it's given, which lands on the package
 * root for `dist/upkeep.js` but misses entirely for `dist/claude/hooks.js` and
 * `dist/mcp/server.js`. Every caller asking here instead of passing its own
 * `import.meta.url` is what keeps the hook and the MCP server from reading
 * `0.0.0` and re-initing on every single session.
 */
export declare function runningVersion(): string;
/** How long a registry answer is considered current. A day: graft ships far less
 * often than that, and this is a nudge, not a security update. */
export declare const UPDATE_TTL_MS: number;
/** Numeric-dotted compare of the release part only (`1.2.3-beta.1` → `1.2.3`).
 * Prerelease ordering doesn't matter here: the only question either caller asks
 * is "is the thing on npm ahead of what's on disk", and a prerelease that
 * compares equal simply produces no nudge. */
export declare function compareVersions(a: string, b: string): number;
export declare function isNewer(candidate: string | null | undefined, current: string): boolean;
export interface UpdateCache {
    /** Latest version seen on npm, or null when the last fetch failed. */
    latest: string | null;
    /** Epoch ms of the last *attempt* — written by the parent before it spawns the
     * fetch, so a repeatedly-failing fetch can't make every command spawn a child. */
    checkedAt: number;
}
/** Machine-global, not per-repo: "what's the latest graft" is one fact, and a
 * dev with twelve repos should cost the registry one request a day, not twelve. */
export declare function updateCachePath(home?: string): string;
export declare function readUpdateCache(home?: string): UpdateCache | null;
/**
 * The `graft _update-check` command body: hit the registry, store the answer.
 * Runs in a detached child so nothing user-facing ever waits on the network.
 */
export declare function refreshUpdateCache(home?: string, now?: number): UpdateCache;
/** True when the cached answer is missing or older than the TTL. */
export declare function needsRefresh(cache: UpdateCache | null, now?: number): boolean;
/**
 * Kick off a background registry check if the cache has gone stale. Touches
 * `checkedAt` first so concurrent callers (and a child that dies) don't spawn a
 * fetch per invocation. Never waits, never throws.
 *
 * Only called from long-lived or already-slow contexts (a CLI command, MCP
 * boot) — never from a hook, which reads the cache and nothing else.
 */
export declare function maybeRefreshInBackground(home?: string, now?: number): boolean;
/**
 * Refresh the attached brain's rules in a detached child, when they are stale.
 *
 * The same shape as the update check above, and for the same reason: this runs
 * inside session-start hooks and MCP boot, where waiting on the network is a
 * stalled first turn. So nothing here blocks — the child does the fetch and
 * this call returns immediately.
 *
 * Without it a brain is pulled exactly once, at `graft brain connect`, and
 * never again. That was survivable when connecting happened after the brain
 * finished building; it is not survivable now that onboarding connects DURING
 * the build, because the one pull returns an empty rulebook and nothing would
 * ever go back for the real one.
 *
 * The attempt is stamped before spawning, so a brain that is still building
 * costs one request per TTL window rather than one per command.
 */
export declare function maybeRefreshBrainRules(repo: string, now?: number): boolean;
/** One line, or nothing. Nothing is the common case — don't spend context on
 * "you're up to date". */
export declare function formatUpdateNudge(current: string, latest: string | null | undefined): string | null;
/**
 * The subset of `graft init`'s flags a refresh has to replay.
 *
 * Without these, an auto-refresh would install things the user explicitly
 * declined: someone who ran `graft init --no-global` (or `--no-hooks`, or
 * `--no-statusline`) said "keep out of `~/.codex`" / "leave my statusline
 * alone", and a later session silently writing there would be graft overriding a
 * decision rather than maintaining one. Absent from an older stamp → all true,
 * which is what plain `graft init` does.
 */
export interface WiringOpts {
    /** false → never write outside the repo (`--no-global`). */
    global: boolean;
    /** false → skip MCP server registration (`--no-mcp`). */
    mcp: boolean;
    /** false → skip hook installation (`--no-hooks`). */
    hooks: boolean;
    /** false → skip Claude Code statusLine (`--no-statusline` / GRAFT_NO_STATUSLINE). */
    statusline: boolean;
}
export declare const DEFAULT_WIRING_OPTS: WiringOpts;
/** An older stamp has no `opts`; a plain `graft init` wired everything. */
export declare function wiringOpts(stamp: WiringStamp | null): WiringOpts;
export interface WiringStamp {
    /** The graft version whose `init` wrote this repo's agent files. */
    version: string;
    /** Host ids that were wired, so a refresh re-writes exactly those and never
     * silently adopts an agent the user declined in the picker. */
    hosts: string[];
    /** The init flags to replay — see {@link WiringOpts}. */
    opts?: Partial<WiringOpts>;
    at: string;
}
/** Under `graft/.cache/`, beside the other derived state: git-ignored, per-clone,
 * and cheap to lose — a missing stamp just means one idempotent refresh. */
export declare function stampPath(repo: string): string;
export declare function readStamp(repo: string): WiringStamp | null;
export declare function writeStamp(repo: string, version: string, hosts: string[], opts?: Partial<WiringOpts>, at?: string): void;
/**
 * Which agents this repo is *already* wired for, read off disk rather than
 * re-detected. Detection answers "which editors does this machine have"; for a
 * refresh we need "which files did a previous init actually write" — otherwise
 * installing Windsurf once would silently add graft rules to every repo.
 */
export declare function wiredHostIds(repo: string): string[];
export interface WiringRefresh {
    from: string;
    to: string;
    hosts: string[];
    /** True when the refresh included writes outside the repo (`~/.codex/`), so the
     * caller can say so — a session changing machine-wide config should be visible. */
    global: boolean;
}
/**
 * Re-run init's writes when the stamp and the running binary disagree.
 *
 * Deliberately narrow: it refreshes the hosts already wired, replays the flags
 * that init was given, never builds the graph (this runs at session start — a
 * rebuild there would stall the agent's first turn), and no-ops when the repo has
 * no graft wiring at all.
 */
export declare function reconcileWiring(repo: string, current: string, deps: {
    wired?: (repo: string) => string[];
    rewrite: (repo: string, hosts: string[], opts: WiringOpts) => void;
}): WiringRefresh | null;
export declare function formatWiringRefresh(r: WiringRefresh | null): string | null;
//# sourceMappingURL=upkeep.d.ts.map