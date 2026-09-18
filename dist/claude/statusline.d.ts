import { type Stats } from './state.js';
/**
 * The statusline's fast path is the hook-maintained cache (graft/.cache/stats.json).
 * When it's absent — a fresh checkout, or a plain `graft build` that doesn't write the
 * cache — fall back to reading the graph itself (wiring.json) so the bar reflects reality
 * immediately instead of showing "not built". An empty wiring.json is still a graph
 * (docs-only repos legitimately have 0 nodes); "not built" is only when the artifact
 * is missing. The graph carries no drift signal, so it reads as synced until the next
 * edit repopulates the cache. Still a pure read (no subprocess): the cache is preferred
 * because it carries live dirty/stale state.
 */
export declare function resolveStats(dir: string): Stats | null;
export declare function main(): void;
//# sourceMappingURL=statusline.d.ts.map