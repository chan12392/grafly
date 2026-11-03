/**
 * The synthesis step: turn per-file prose summaries into a CURATED set of graph
 * nodes. This is where granularity is decided — the model groups related files
 * into subsystem nodes, keeps a notable file as its own node when it deserves
 * one, and adds cross-cutting concept nodes, instead of emitting one entity per
 * incidental identifier. Each node is attributed to the source files it is
 * grounded in, so provenance (and staleness) stays exact.
 */
import type { ChatModel } from "./llm/types.js";
/** A directed edge to another node, by node name (resolved to a slug later). */
export interface SynthLink {
    to: string;
    relation: string;
    description?: string;
}
/** A node as proposed by the synthesizer, before it is written to disk. */
export interface SynthNode {
    name: string;
    /** system | api | file | concept */
    type: string;
    summary: string;
    /** Source file paths (from the provided set) this node is grounded in. */
    sources: string[];
    links: SynthLink[];
}
/** One labeled file summary fed into synthesis. */
export interface FileSummary {
    path: string;
    summary: string;
}
export interface Synthesizer {
    synthesize(files: FileSummary[]): Promise<SynthNode[]>;
}
/** Synthesizer backed by any {@link ChatModel} via forced tool calling. */
export declare class ChatSynthesizer implements Synthesizer {
    private model;
    constructor(model: ChatModel);
    synthesize(files: FileSummary[]): Promise<SynthNode[]>;
}
