import { type Direction } from "./traverse.js";
import type { GraphV1 } from "./types.js";
import { type AskResult } from "../ask/ask.js";
import { type GrepResult } from "../search/grep.js";
import { formatGrepResult, zeroHitNote } from "../search/grep-cli.js";
/** The parent index written to `<parent>/graft/workspace.json`. Nodes/edges
 * never live at the parent — they live in each child's own `graft/`. */
export interface WorkspaceV1 {
    version: 1;
    /** Immediate child dir names that are git repos, sorted. */
    children: string[];
}
/** Absolute path to the workspace index for a parent root (`<dir>/graft/workspace.json`). */
export declare function workspacePath(root: string, override?: string): string;
/** Read the workspace index, or null when the parent has none (not a workspace,
 * or unparseable/foreign json — treated the same as absent). */
export declare function readWorkspace(root: string, override?: string): WorkspaceV1 | null;
/** Write the workspace index, sorting children for a stable, minimal git diff. */
export declare function writeWorkspace(root: string, ws: WorkspaceV1, override?: string): string;
/** A parent is a workspace BUILD target when it has no own `.git` and ≥2 git
 * children — or it was already split (a `workspace.json` is present). The
 * no-own-`.git` guard keeps a normal repo with git submodules from being
 * mistaken for a workspace. */
export declare function isWorkspaceBuildRoot(root: string, override?: string): boolean;
/** True when the parent has a mega-graph from an older single-graph build
 * (`graft/.graph/wiring.json`) — the thing a workspace build migrates away. */
export declare function hasMegaGraph(root: string, override?: string): boolean;
/** The EXACT split warning printed once, when a mega-graph parent is first
 * built as a workspace. Templated on the child list so it names the real repos. */
export declare function migrationNote(children: string[]): string;
/** Remove the parent's entire `graft/` tree — the mega-graph, its `.cache`, and
 * any stale cards — so after `writeWorkspace` the parent holds ONLY
 * workspace.json. Child graphs live in sibling `<child>/graft/`, never under
 * this dir, so they are untouched. */
export declare function clearParentGraft(root: string, override?: string): void;
export interface LoadedChild {
    child: string;
    graph: GraphV1;
}
export interface WorkspaceGraphs {
    /** Children (from workspace.json when present, else discovered) that have a
     * built graph, in sorted child order. */
    loaded: LoadedChild[];
    /** Listed children with no built graph yet — surfaced, never silently skipped. */
    missing: string[];
}
/** Load each child's graph via `loadGraphCached`. Children come from
 * workspace.json when present, otherwise from live git-child discovery (a
 * not-yet-built workspace). A child without a built graph is counted into
 * `missing`, not dropped. */
export declare function loadWorkspaceGraphs(root: string, override?: string): WorkspaceGraphs;
/** "2 of 3 workspace repos have graphs; run graft build to cover repoC" — the
 * coverage line federated commands append when some listed child is unbuilt.
 * Empty string when every child has a graph. */
export declare function coverageNote(g: WorkspaceGraphs): string;
export interface FederateAskOptions {
    limit?: number;
    source?: boolean;
    full?: boolean;
    graphRank?: boolean;
    /** Narrow to one child (`repoA`) or a sub-scope within it (`repoA/backend`).
     * A prefix matching NO child throws, listing the repos. */
    in?: string;
    /** @internal File-level child RRF plus an exact workspace baseline top lock. */
    fileTopLock?: boolean;
}
/**
 * Federated `ask` across a workspace: run each child's own ask pipeline, then
 * fuse ALL the children's scope lists with `fuseScopes` (reciprocal rank). Each
 * child contributes one fusion scope per intra-child scope, labeled
 * `<child>/<scope>` (or just `<child>` for a child's root scope), so a big repo
 * can't drown a small one — rank positions are comparable across repos where
 * raw scores are not.
 *
 * Rank fusion is still right HERE, and only here: each child was scored against
 * its own corpus, so cross-child scores share no scale. Within a single repo
 * that is no longer true — `rankScopesAndFuse` gives every scope the same
 * statistics and the same denominator and combines them by score.
 *
 * Returns a normal `AskResult`; `formatAsk` renders it unchanged, labeling each
 * hit `[<child>/…]` via the standard multi-scope path.
 */
export declare function federateAsk(root: string, override: string | undefined, query: string, opts?: FederateAskOptions): AskResult;
/** Merge every child's `GrepResult` into one, prefixing group paths with the
 * child dir and re-sorting by coupling (inDegree desc, path asc) across repos.
 * In-degree stays each child's own — it comes from that child's graph. */
export declare function federateGrep(root: string, override: string | undefined, pattern: string, opts?: {
    ignoreCase?: boolean;
    fixed?: boolean;
}): {
    result: GrepResult;
    coverage: string;
};
/** One `graft map` section per child (each child's own map, budget split evenly
 * across the loaded children), joined under `<child>/` headers. */
export declare function federateMap(root: string, override: string | undefined, opts?: {
    maxDirs?: number;
}): string;
/** Per-child drift status. `ok` is false when any BUILT child is stale — an
 * unbuilt child is surfaced (coverage), never a failure. */
export declare function federateCheck(root: string, override?: string): Promise<{
    text: string;
    ok: boolean;
}>;
/** Resolve a symbol across every child, grouped per child. Reuses the shared
 * traverse-cli formatters so each block reads exactly like `graft callers`. */
export declare function federateCallers(root: string, override: string | undefined, symbol: string, opts?: {
    direction?: Direction;
    depth?: number;
    in?: string;
}): {
    text: string;
    found: boolean;
};
/**
 * Split a parent into a workspace: build each git child (via the supplied
 * `buildChild` callback, so this stays free of any engine/LLM dependency),
 * then REPLACE the parent's `graft/` with just `workspace.json`. `onStart`
 * fires once — before any child is built — carrying whether this build is a
 * mega-graph migration, so the caller can print the one-time split warning
 * first, exactly as the spec requires.
 *
 * The child build writes into `<child>/graft/` and is byte-identical to
 * building that child standalone (`buildChild` is just `buildGraph(childDir)`),
 * because nothing about the parent path enters the child's build.
 */
export declare function splitWorkspace(root: string, override: string | undefined, buildChild: (childDir: string, childName: string) => Promise<void>, onStart?: (info: {
    children: string[];
    migrated: boolean;
}) => void): Promise<{
    children: string[];
    migrated: boolean;
}>;
export { formatGrepResult, zeroHitNote };
//# sourceMappingURL=workspace.d.ts.map