import type { ChatModel } from "../ai/llm/types.js";
import type { GraphV1 } from "../graph/types.js";
import type { BlastReport } from "./blast.js";
/** One cluster to name: its identity, its files and the symbols inside it. */
export interface Cluster {
    key: string;
    files: string[];
    symbols: string[];
}
/** Anything that can turn clusters into names. A model in production, a stub in tests. */
export interface Namer {
    /** Names by cluster key. A key the namer chose not to name is simply absent. */
    name(clusters: Cluster[]): Promise<Map<string, string>>;
}
export interface NameStats {
    /** Labels taken from the cache, and labels that cost a call. */
    cached: number;
    named: number;
    /** Clusters the namer declined ("mixed") or could not answer for. */
    declined: number;
    /** Set when naming was attempted and failed outright; the reason, for one line
     * in the report. Never thrown: a comment without names still beats no comment. */
    error?: string;
}
/** The production namer: one forced-tool call for every cluster at once. */
export declare class ChatNamer implements Namer {
    private readonly model;
    constructor(model: ChatModel);
    name(clusters: Cluster[]): Promise<Map<string, string>>;
}
/**
 * A model-written string on its way into a Mermaid label and a markdown table.
 *
 * Symbol names from a fork's diff reach the prompt, so the answer is untrusted
 * input: anything that could close a label, open a tag or start a table cell is
 * stripped here rather than at each render site.
 */
export declare function sanitize(raw: string): string;
/**
 * The cache key for a cluster: what it contains, not what it is called.
 *
 * Member paths pin the shape and each member's `body_hash` pins the content, so a
 * cluster is renamed only when the code in it actually changes. Without this the
 * same area gets a slightly different name on every PR and two comments stop being
 * comparable — the failure the cache exists to prevent.
 */
export declare function clusterHash(files: string[], hashes: Map<string, string>): string;
export declare function loadNameCache(contextDir: string): Record<string, string>;
export declare function saveNameCache(contextDir: string, names: Record<string, string>): void;
/**
 * Fill in labels for every cluster still sitting on its symbol backstop.
 *
 * Clusters already named by a concept node are left alone: a concept was written
 * from whole file bodies, which is strictly more than the paths and symbol names
 * this pass can see.
 */
export declare function applyNames(graph: GraphV1, report: BlastReport, opts: {
    namer?: Namer;
    contextDir: string;
}): Promise<NameStats>;
/**
 * Name the clusters left on their symbol backstop, and say what it cost.
 *
 * Everything here is best-effort by construction: no key, a spent quota or a
 * refused call leaves the backstop labels in place, because neither a PR check
 * nor a review comment should fail over a cosmetic layer. The note comes back
 * rather than going to a stream, so `graft blast --name` can prefix it and the
 * App can log it against the pull request it belongs to.
 */
export declare function nameReport(graph: GraphV1, report: BlastReport, contextDir: string): Promise<{
    stats: NameStats;
    note: string | null;
}>;
//# sourceMappingURL=name.d.ts.map