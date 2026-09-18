export interface VizNode {
    id: string;
    name: string;
    type: string;
    summary: string;
    sources: string[];
    /** Code to show under the node, in place of `sources`. Set by
     * `blast --export-viz`, where every node stands for real changed lines. */
    evidence?: Evidence[];
    /** Who has worked on this area, best first. Set by `blast --export-viz`. */
    owners?: NodeOwner[];
}
/**
 * One contributor on a node, as the exported page carries them.
 *
 * `last` is an ISO day rather than "9d ago" so the page stays truthful when it is
 * opened a fortnight after it was published — the viewer does the arithmetic at
 * read time. `handle` is absent whenever git carried no GitHub address for them,
 * and the viewer must then render the name unlinked.
 */
export interface NodeOwner {
    name: string;
    handle?: string;
    commits: number;
    /** `YYYY-MM-DD` of their most recent commit in this area. */
    last: string;
}
export interface VizEdge {
    source: string;
    target: string;
    relation: string;
    description?: string;
}
/**
 * One line of code shown under a node, with the sign git gave it (` ` for an
 * unchanged line quoted as context — the affected side has no diff to show).
 */
export interface EvidenceLine {
    /** Post-image line number; a deleted line has none. */
    n: number | null;
    sign: "+" | "-" | " ";
    text: string;
}
/**
 * A snippet a panel shows instead of a bare path.
 *
 * A reviewer reading "src/blast/blast-cli.ts · L172-L193" has to go and open the
 * file to learn anything; the same block with four lines of the actual change in
 * it answers the question where they are standing.
 */
export interface Evidence {
    /** `symbol · path:12-34` — grep-able, because a span alone is not. */
    label: string;
    /** Why these lines are here, e.g. `calls blastVizGraph` or `added`. */
    note?: string;
    lines: EvidenceLine[];
    /** Lines the cap dropped, so a folded hunk says so rather than lying. */
    more?: number;
}
export interface VizGraph {
    meta: {
        nodeCount: number;
        edgeCount: number;
        skippedFiles: number;
        droppedEdges: number;
        /** Why there is nothing to draw, when there is nothing to draw. A published
         * page cannot answer a question a reader asks of the console, so an empty
         * canvas has to say what it means — see `blastVizGraph`. */
        emptyNote?: string;
    };
    nodes: VizNode[];
    edges: VizEdge[];
}
/**
 * Legacy vague verbs → the concrete verb they usually mean. Keeps old
 * `.context/` folders readable without regeneration; the synthesizer itself
 * is constrained to the closed vocabulary going forward.
 */
export declare const NORMALIZE_RELATION: Record<string, string>;
export declare function normalizeRelation(rel: string): string;
/** Read a context dir and assemble the render-ready graph document. */
export declare function assembleContextGraph(contextDir: string): VizGraph;
//# sourceMappingURL=assemble.d.ts.map