import { type EnrichStats } from "./enrich.js";
import type { Kind, Relation } from "./types.js";
import type { CruxSummarizer } from "../ai/crux.js";
export { listSourceFiles } from "./source-files.js";
export interface GraphBuildOptions {
    /** Override the output dir (default: `<root>/.context`). */
    contextDir?: string;
    /** Replay unchanged files from the extraction cache instead of re-parsing them
     * (default true). False forces a cold parse of the whole repo. */
    reuse?: boolean;
    /** Write only what a query reads — the graph, the `ask` sidecar, the freshness
     * record — and skip the markdown projections and the `.gitignore` touch. Set by
     * the pre-query refresh (`graph/refresh.ts`); an explicit `graft build` never
     * sets it. See the write block in {@link buildGraph} for why the split exists. */
    graphOnly?: boolean;
    /** Opt-in compiler-grade edge enrichment via a language server (`graft build
     * --lsp`): adds `lsp_resolved` call edges the AST resolver couldn't (member
     * calls, breadth-tier calls). Off by default — needs a server on PATH and is
     * slower; the graph is fully functional without it. */
    lsp?: boolean;
    /** Run the Tier-2 LLM meaning pass. Absent → Tier-1 only (cache is still preserved). */
    summarizer?: CruxSummarizer;
    /** Max files summarized in parallel during the Tier-2 pass. Default is set in enrich. */
    concurrency?: number;
    /** Repo-relative directory prefixes to limit the build to (`--only-dir`). When
     * set, only files under these prefixes are indexed; the list is recorded in the
     * fingerprint so the freshness probe enumerates the same set. */
    onlyDirs?: string[];
    onProgress?: (info: {
        phase: "parse" | "enrich";
        index: number;
        total: number;
        file: string;
    }) => void;
}
export interface GraphBuildResult {
    contextDir: string;
    graphPath: string;
    /** Per-file wiring cards written (Tier-2 passive surface). */
    cards: number;
    files: number;
    /** Files re-parsed this run (the rest were replayed from the extraction cache). */
    parsed: number;
    /** Files replayed from the extraction cache. */
    reused: number;
    /** The parent checkout this build copied a starting graph from, when it was run in
     * a git worktree that had none of its own. See `./seed.ts`. */
    seededFrom?: string;
    nodes: number;
    edges: number;
    byKind: Record<Kind, number>;
    byRelation: Record<Relation, number>;
    languages: string[];
    meaning: EnrichStats;
    errors: string[];
}
export declare function buildGraph(dir: string, opts?: GraphBuildOptions): Promise<GraphBuildResult>;
//# sourceMappingURL=build.d.ts.map