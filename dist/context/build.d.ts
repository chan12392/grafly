import type { Summarizer } from "../ai/summarize.js";
import type { Synthesizer } from "../ai/synthesize.js";
/** Extensions treated as source code. */
export declare const CODE_EXTENSIONS: string[];
export interface BuildProgress {
    phase: "summarize" | "synthesize" | "write";
    index: number;
    total: number;
    file: string;
}
export interface BuildOptions {
    /** Override the output dir (default: `<root>/.context`). */
    contextDir?: string;
    /** Extensions to treat as code. Default: {@link CODE_EXTENSIONS}. */
    extensions?: string[];
    /** Repo-relative directory prefixes to limit the concept pass (`--only-dir`).
     * Same prefix semantics as the wiring walk. When omitted, falls back to the
     * whitelist recorded in the graph fingerprint (mirrors `checkGraph`). */
    onlyDirs?: string[];
    /** Human label for the model, recorded in the manifest (e.g. "openrouter:openai/gpt-4o-mini"). */
    model: string;
    summarizer: Summarizer;
    synthesizer: Synthesizer;
    /** Files summarized in parallel during phase 1. Default 8. Raised via `graft build -j`. */
    concurrency?: number;
    onProgress?: (info: BuildProgress) => void;
}
export interface BuildResult {
    contextDir: string;
    files: number;
    summarized: number;
    cached: number;
    batches: number;
    nodes: number;
    links: number;
    errors: string[];
    /** Files whose summary call failed, and files never attempted once the pass gave
     * up — reported as data so the CLI can exit non-zero without reading messages (#127). */
    failedFiles: number;
    skippedFiles: number;
    /** Why the summarize phase stopped early, when it did. */
    fatal?: string;
}
/**
 * Files the concept pass summarizes (and `checkContext` re-hashes): the same
 * walk as before (`--include-dir` / submodule flags from state, minus the
 * output dir), then {@link filterByOnlyDirs}. Shared so build and check cannot
 * disagree about what "current" means under a whitelist.
 */
export declare function listContextFiles(root: string, outDir: string, exts: readonly string[], explicitOnlyDirs?: readonly string[]): string[];
export declare function buildContext(dir: string, opts: BuildOptions): Promise<BuildResult>;
//# sourceMappingURL=build.d.ts.map