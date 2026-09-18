/**
 * Tier-2 pass: attach the LLM meaning layer (`summary` + `crux`) to nodes.
 *
 * graph.json is its own cache — the committed file already holds every node's
 * summary/crux from a prior run. So this pass is diff-driven:
 *
 *   - cache hit  — a prior node with the same id, same `body_hash`, and
 *     `summary_state:"ready"` → carry its summary/crux over, no LLM call.
 *   - stale      — a prior ready summary whose body has since changed → keep the
 *     old text as a hint but mark it "stale". Recomputed only if an LLM is given.
 *   - pending    — new or never-summarized node → one LLM call when an LLM is
 *     given, otherwise left "pending".
 *
 * Passing no summarizer runs the cache/stale bookkeeping alone (no calls, no
 * cost) — which is what a plain `graph` build does, so it never wipes the
 * meaning layer a previous `--llm` run produced.
 *
 * The LLM returns line numbers into the slice it was shown; we consume them here,
 * once, to cut `crux.code` verbatim from the source. `crux.span` is a pointer
 * only and is never used to re-slice.
 */
import { type CruxSummarizer } from "../ai/crux.js";
import type { NodeV1 } from "./types.js";
export interface EnrichOptions {
    /** When present, (re)compute meaning for stale/pending nodes. Absent → cache only. */
    summarizer?: CruxSummarizer;
    /** Max files summarized in parallel (each is one LLM call). Default {@link DEFAULT_CONCURRENCY}. */
    concurrency?: number;
    /** Progress is reported per file (one LLM call each), as files finish — not per node. */
    onProgress?: (info: {
        index: number;
        total: number;
        node: string;
    }) => void;
    /**
     * Durability flush of the (partially) enriched graph, called from the per-file
     * completion handler at most once every {@link CHECKPOINT_MS}. Without it, crux
     * only reached wiring.json at build end, so an interrupted --deep run discarded
     * every crux it had already computed and paid for (#128). Single-threaded, so it
     * never interleaves with a node mutation.
     */
    checkpoint?: () => void;
}
export interface EnrichStats {
    cached: number;
    computed: number;
    stale: number;
    pending: number;
    errors: string[];
    /** Files whose LLM call failed outright. The count `errors` used to only imply —
     * a caller has to be able to decide "this build is degraded" without parsing
     * message strings (#127). */
    failedFiles: number;
    /** Files never attempted, because {@link EnrichStats.fatal} stopped the pass. */
    skippedFiles: number;
    /** Set when the pass gave up early: quota/auth rejection, or a run of
     * provider failures. Content-quality misses (#235) count in `failedFiles` but
     * do not set this. The reason is what `graft build --deep` exits non-zero with. */
    fatal?: string;
}
export declare function enrichGraph(nodes: NodeV1[], prior: Map<string, NodeV1>, sources: Map<string, string>, opts?: EnrichOptions): Promise<EnrichStats>;
//# sourceMappingURL=enrich.d.ts.map