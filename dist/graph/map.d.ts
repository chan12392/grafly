/**
 * `graft map` core: a deterministic, token-budgeted repo orientation —
 * directory clusters, per-directory hubs, and global hotspots — computed
 * purely from the wiring graph (no LLM, no I/O beyond the already-loaded
 * `GraphV1`).
 *
 * Grouping is by first path segment (`src/cache.ts` → `src`), so a coding
 * agent gets the same top-level shape a human sees in a file tree. When one
 * segment swallows most of the repo (a flat `src/` with everything under
 * it), that single group would be useless as an orientation aid, so it gets
 * one refinement pass: split one level deeper (`src` → `src/ask`,
 * `src/graph`, …). Hubs and hotspots rank by incoming `WALK_RELATIONS`
 * edges (shared with `graphrank.ts`/`grep.ts`, so "important" means the same
 * thing everywhere in graft) — never by lines of code or heuristics that
 * drift from the actual wiring.
 *
 * Pure and synchronous: same fixture-testable shape as `grep.ts` — no CLI or
 * MCP concerns live here. `cli.ts` and `mcp/tools.ts` both call
 * `buildRepoMap` + `formatRepoMap` directly.
 */
import type { GraphV1 } from "./types.js";
import { type Savings } from "../context/savings.js";
export interface Hub {
    name: string;
    kind: string;
    path: string;
    span: string;
    inDegree: number;
}
export interface DirEntry {
    path: string;
    files: number;
    symbols: number;
    languages: string[];
    hubs: Hub[];
    /** True when the >60% split refinement bottomed out on a file that sits
     * directly in the split directory (no deeper subdirectory to split into —
     * see `dirKey`'s doc). In that case `path` IS a file's own full path, not
     * a directory, so `formatDirLine` must not append a trailing "/". False
     * for every real directory group (the overwhelming majority). */
    isFile: boolean;
}
/** One scope's own directory breakdown — same shape a single-scope `buildRepoMap`
 * would produce for that scope's nodes alone, dir paths repo-rooted (not
 * scope-relative) so a hit is directly openable without mentally re-prefixing. */
export interface ScopeGroup {
    /** Display label via `scopeLabel` — "(root)" or "backend/". */
    scope: string;
    /** Sorted by symbol count desc (ties by path asc), capped at `maxDirs`. */
    dirs: DirEntry[];
    /** This scope's directory groups beyond the `maxDirs` cap. */
    dropped: number;
}
export interface RepoMap {
    totals: {
        files: number;
        symbols: number;
        edges: number;
        languages: string[];
    };
    /** Single-scope repos: sorted by symbol count desc (ties by path asc), capped
     * at `maxDirs`. Multi-scope repos: empty — use `scopes` instead (see below). */
    dirs: DirEntry[];
    /** Multi-scope repos ONLY (`scopesOfGraph(graph).length > 1`): one entry per
     * scope, scope label as the top-level group key, that scope's own dirs
     * second — a monorepo's sub-projects each read like their own little map
     * instead of being pooled by raw first-path-segment. Absent on single-scope
     * repos (the byte-identical-output regression guarantee: same
     * `scopesOfGraph(g).length <= 1` early branch `ask.ts` uses). */
    scopes?: ScopeGroup[];
    /** Global top hubs by inDegree, ties by name asc then path asc. */
    hotspots: Hub[];
    /** Directory groups beyond the `maxDirs` cap — never silently dropped.
     * Multi-scope repos: always 0 here; see each `ScopeGroup.dropped` instead. */
    dropped: number;
    /** Tokens-saved baseline: every indexed file read whole — the cost of
     * orienting by reading the repo instead of this map. */
    saved?: Savings;
}
export interface BuildRepoMapOptions {
    /** Max directory entries kept (the rest are counted into `dropped`). Default 16. */
    maxDirs?: number;
    /** Max hubs listed per directory. Default 3. */
    hubsPerDir?: number;
    /** Max global hotspots. Default 12. */
    hotspots?: number;
}
/**
 * Build the repo map from an already-loaded `GraphV1`. Deterministic: same
 * graph in → byte-identical `RepoMap` out (modulo insertion order, which is
 * never observed — everything meaningful is sorted).
 *
 * Single-scope repos (`scopesOfGraph(graph).length <= 1`, the overwhelming
 * majority) take the exact pre-scope-awareness path below — same branch guard
 * `ask.ts` uses, so this is a byte-level regression guarantee. Multi-scope
 * repos group `dirs` by scope FIRST (see `scopes` on `RepoMap`); `dirs` itself
 * is then empty and `scopes` carries the breakdown instead.
 */
export declare function buildRepoMap(graph: GraphV1, opts?: BuildRepoMapOptions): RepoMap;
/**
 * Render a `RepoMap` as the human report. Deterministic (same map in → same
 * string out) and targets <= 6000 chars for a typical repo (the `maxDirs`/
 * `hubsPerDir`/`hotspots` caps in `buildRepoMap` are what keep it bounded on
 * very large graphs).
 */
export declare function formatRepoMap(map: RepoMap): string;
//# sourceMappingURL=map.d.ts.map