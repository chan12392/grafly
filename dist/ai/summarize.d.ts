import type { ChatModel } from "./llm/types.js";
/**
 * Turns one source-code file into a short prose summary for the knowledge graph.
 *
 * Code repos are deliberately NOT fed through the per-chunk entity extractor:
 * static structure is better served by grep/tree-sitter in the consuming agent,
 * and LLM extraction over raw code produces noisy, duplicated entities. Instead
 * the repo ingest path summarizes each file into plain English (purpose, key
 * exports, dependencies, design decisions) and ingests those summaries — prose
 * the existing extraction pipeline is actually good at.
 */
export interface Summarizer {
    summarize(code: string, opts: {
        path: string;
    }): Promise<string>;
}
/** Summarizer backed by any {@link ChatModel} (a plain-text completion). */
export declare class ChatSummarizer implements Summarizer {
    private model;
    constructor(model: ChatModel);
    summarize(code: string, opts: {
        path: string;
    }): Promise<string>;
}
