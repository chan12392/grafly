/**
 * Tier-2 "meaning" call for the code graph — batched one request per file.
 *
 * Given a source file (with 1-based line numbers) and the list of definitions in
 * it, one call returns, for each definition:
 *   1. `summary` — one plain-English sentence: what the symbol is *for*, at the
 *      business-logic level, not a restatement of its signature.
 *   2. `crux_start`/`crux_end` — the smallest contiguous range of FILE line
 *      numbers (inside that symbol's own span) that a reviewer must read to see
 *      the decision or rule the code encodes. `0/0` means there is no single
 *      crux (a trivial getter, a plain data holder).
 *
 * Batching per file means N definitions cost one request, not N — and the model
 * sees each symbol's neighbours, which sharpens the summaries. Line numbers are
 * consumed once, at write time, to slice the crux text verbatim from source.
 */
import type { ChatModel, ChatResponse } from "./llm/types.js";
import type { Kind } from "../graph/types.js";
/** One definition we want described, located by its line span within the file. */
export interface NodeRef {
    id: string;
    kind: Kind;
    signature: string | null;
    startLine: number;
    endLine: number;
}
export interface FileCruxInput {
    path: string;
    source: string;
    nodes: NodeRef[];
}
export interface NodeCrux {
    id: string;
    summary: string;
    crux_start: number;
    crux_end: number;
}
export interface CruxSummarizer {
    describeFile(input: FileCruxInput): Promise<NodeCrux[]>;
    /** Set by {@link ChatCruxSummarizer} after each call; optional on fakes. */
    lastMiss?: CruxMiss | null;
}
/** Why a crux call produced no usable summaries (#235). */
export type CruxMissKind = "empty-toolCalls" | "unparseable" | "truncated" | "empty-parsed";
export interface CruxMiss {
    kind: CruxMissKind;
    finishReason: string | null;
}
/** Classify an empty/unusable crux reply. `null` means at least one usable summary. */
export declare function classifyCruxMiss(res: ChatResponse, parsed: NodeCrux[]): CruxMiss | null;
/** Per-file error text: miss class + the provider's finish_reason (#235). */
export declare function formatCruxMiss(kind: CruxMissKind, finishReason: string | null): string;
/** Crux summarizer backed by any {@link ChatModel} via forced tool calling. */
export declare class ChatCruxSummarizer implements CruxSummarizer {
    private model;
    lastMiss: CruxMiss | null;
    constructor(model: ChatModel);
    describeFile(input: FileCruxInput): Promise<NodeCrux[]>;
}
