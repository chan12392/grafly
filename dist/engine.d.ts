/**
 * The Context Graph Engine.
 *
 * Two operations, no database:
 *   - {@link Graft.init}  build `.context/` from a code repo.
 *   - {@link Graft.check} report whether `.context/` is still in
 *     sync with the code (for CI).
 *
 * The graph is a folder of linked markdown files committed to the repo; git is
 * the sync. This class wires the configured LLM provider into the build/check
 * pipelines; an API key is required for any LLM-backed operation.
 */
import { type EngineConfig } from "./ai/providers.js";
import { CODE_EXTENSIONS, type BuildProgress, type BuildResult } from "./context/build.js";
import { type CheckResult } from "./context/check.js";
import { type GraphBuildOptions, type GraphBuildResult } from "./graph/build.js";
import { type GraphCheckResult } from "./graph/check.js";
import { type AskResult } from "./ask/ask.js";
export { CODE_EXTENSIONS };
export type { BuildResult, BuildProgress, CheckResult, GraphBuildResult, GraphCheckResult, AskResult };
export interface InitOptions {
    /** Code extensions to include. Default: {@link CODE_EXTENSIONS}. */
    extensions?: string[];
    /** Repo-relative directory prefixes to limit the concept pass (`--only-dir`). */
    onlyDirs?: string[];
    /** Progress callback for long builds. */
    onProgress?: (info: BuildProgress) => void;
}
export interface CheckRunOptions {
    extensions?: string[];
}
export interface GraphRunOptions {
    /** Run the Tier-2 LLM meaning pass (summary + crux). Absent → Tier-1 only. */
    llm?: boolean;
    /** Max files summarized in parallel during the LLM pass. */
    concurrency?: number;
    /** Replay unchanged files from the extraction cache (default true). */
    reuse?: boolean;
    /** Opt-in compiler-grade LSP edge enrichment (`graft build --lsp`). */
    lsp?: boolean;
    /** Repo-relative directory prefixes to limit the build to (`--only-dir`). */
    onlyDirs?: string[];
    onProgress?: GraphBuildOptions["onProgress"];
}
export declare class Graft {
    private cfg;
    constructor(config?: EngineConfig);
    /** Build the `.context/` graph from the repo at `dir`. */
    init(dir: string, opts?: InitOptions): Promise<BuildResult>;
    /** Report whether the committed `.context/` markdown graph is in sync with the code. */
    check(dir: string, opts?: CheckRunOptions): CheckResult;
    /** Report whether the committed `graph.json` is in sync with the code (Tier-1 diff).
     * Async because the breadth tier warms WASM grammars before re-extraction. */
    checkGraph(dir: string): Promise<GraphCheckResult>;
    /**
     * Build `.context/graph.json` — a per-symbol code graph from tree-sitter.
     * Tier-1 (structure) always runs; the Tier-2 meaning layer runs only when
     * `opts.llm` is set. Either way the prior meaning layer is preserved.
     */
    graph(dir: string, opts?: GraphRunOptions): Promise<GraphBuildResult>;
    /**
     * Answer a plain-words query from the committed `graft/` graph — the active
     * channel. Deterministic and $0: routes structural queries to the wiring
     * edges and everything else to a lexical rank over concepts + symbols.
     */
    ask(dir: string, query: string, opts?: {
        limit?: number;
        source?: boolean;
        full?: boolean;
        in?: string;
        graphRank?: boolean;
    }): AskResult;
    private _chatModel?;
    /** The configured transport, or a clear error telling the user how to set a key. */
    private chatModel;
    private synthesizer;
    /** Per-node crux summarizer for the code graph's Tier-2 pass. */
    private cruxSummarizer;
    private summarizer;
    /** Human label for the active model, recorded in the manifest. */
    private modelLabel;
}
//# sourceMappingURL=engine.d.ts.map