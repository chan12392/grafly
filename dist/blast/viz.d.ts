/**
 * The blast radius as a graph the viewer can draw — the hosted half of the PR
 * comment.
 *
 * The comment can hold about five circles before it stops being readable, and it
 * can never answer the reviewer's next question: which symbols, at which lines,
 * and what did they actually become. `graft viz --export` already produces a
 * self-contained page, but its Context tab is assembled from the deep tier's
 * concept files, which the PR path deliberately no longer builds — so on a
 * structural build that tab held a single INDEX dot.
 *
 * This closes that gap with no new data and no LLM pass: `blast` has already
 * clustered both sides of the diff and named them (cached, one call), so the same
 * report is emitted here as {@link VizGraph} — amber node per changed area, blue
 * node per affected area, one edge per attribution the walk actually recorded.
 *
 * Each node also carries {@link Evidence}: the changed side shows its hunks, the
 * affected side shows the line that reaches the diff. Both come from data already
 * on hand — git's patch, and the file on disk — so the panel costs nothing.
 */
import type { VizGraph } from "../viz/assemble.js";
import type { BlastReport } from "./blast.js";
/**
 * Build the viewer graph for a report.
 *
 * `root` is the repository the report was taken in; without it the affected side
 * loses its snippets — there is nothing to read — but keeps everything else, which
 * is what a unit test wants.
 *
 * Nothing is capped at the graph level. The caps in the markdown renderer exist
 * because a Mermaid diagram inside a comment cannot lay out more than a handful of
 * circles; this page is force-directed and pannable, which is why it exists.
 */
export declare function blastVizGraph(r: BlastReport, opts?: {
    root?: string;
}): VizGraph;
//# sourceMappingURL=viz.d.ts.map