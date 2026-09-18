import type { GraphV1, ScopeV1 } from "./types.js";
/** Walk the tree (reusing `walkDir`'s persisted directory and submodule
 * choices) and find project-marker dirs. */
export declare function discoverScopes(root: string, repoFiles?: string[]): ScopeV1[];
/** Nearest-prefix owner. `scopes` MUST be sorted prefix-length desc; "" matches all.
 * Falls back to a synthetic root scope when `scopes` has no explicit "" entry and
 * nothing else matches — every path resolves to some scope. */
export declare function scopeOf(path: string, scopes: ScopeV1[]): ScopeV1;
/** Display form of a scope prefix: "" reads as "(root)", everything else gets
 * a trailing slash. Shared by ask's `matched in:`/`also matched:` footer, the
 * `--in` no-match error, and the multi-scope zero-hit note. */
export declare function scopeLabel(prefix: string): string;
/** " — scopes here: a/ · b/" when `scopes` is genuinely multi-scope (>1
 * entries), else "" — the shared clause `ask` appends to its zero-hit note
 * and its `--in` no-match error, so a caller is always told what IS indexed
 * rather than getting a bare miss. */
export declare function scopesHereClause(scopes: ScopeV1[]): string;
/** Segment-aware "is `path` at or under `prefix`?" — a plain `path.startsWith`
 * would wrongly let "frontend" match "frontend-utils"; this requires an exact
 * segment boundary, same rule `scopeOf` uses for its own prefix match. Root
 * (`""`) matches every path. Used to filter ask's doc/node set for
 * `--in <path-prefix>`. */
export declare function pathUnderPrefix(path: string, prefix: string): boolean;
/**
 * Validate a normalized `--in` prefix against the graph before a query runs. A
 * prefix matching no indexed node is a caller mistake (typo, wrong sub-project,
 * or a mid-path fragment where a prefix is required) rather than a legitimate
 * zero-hit query, so every `--in`-taking command fails loudly and identically
 * instead of printing empty output the caller has to interpret.
 *
 * Pass the prefix through `normalizePathPrefix` first — an un-normalized
 * `src\gpu` or `src/` will not match anything here.
 */
export declare function assertPrefixIndexed(graph: GraphV1, prefix: string): void;
/** Immediate subdirs of `root` that are themselves git repos (have `.git`).
 * Used by workspace federation (Task 5). */
export declare function discoverWorkspaceChildren(root: string): string[];
/** Every consumer's entry point to a graph's scopes: absent `meta.scopes` (old
 * graphs, or graphs where discovery found nothing but the root) defaults to the
 * canonical single-scope form. Never read `graph.meta.scopes` directly. */
export declare function scopesOfGraph(graph: GraphV1): ScopeV1[];
//# sourceMappingURL=scopes.d.ts.map