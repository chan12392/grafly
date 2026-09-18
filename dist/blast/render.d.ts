/**
 * Renderers for a {@link BlastReport}: the Mermaid+markdown comment body a CI job
 * posts, and a plain-text report for a terminal.
 *
 * The diagram is the product here — a reviewer should see which areas a change
 * reaches, and whether its tests moved, before reading a single path — so the
 * markdown leads with it and keeps every per-symbol list collapsed underneath.
 * GitHub renders Mermaid natively in comments, so there is nothing to host.
 *
 * Both sides of the diagram are drawn at the same grain: areas, not files. The
 * first version drew one box per changed file, which cannot fit a real PR (24 files
 * against a cap of ten) and told a reviewer nothing per box — `src/graph/write.ts`
 * on its own is not a unit anyone reasons about.
 */
import type { BlastReport } from "./blast.js";
/**
 * The diagram: one circle per area that can be affected, and nothing else.
 *
 * Everything about the changed side is gone on purpose. Drawing which of your edits
 * reaches which area is a many-to-many relation, so it can only ever render as a
 * mesh — nine arrows over eleven circles at its tidiest — and the reviewer has to
 * trace lines to read it. That relation still exists in the table's "Reached from"
 * column, where a reader can look it up when they want it, so the picture is free
 * to answer the only question it is asked at a glance: what can break?
 *
 * `TB`, not `LR`: with no edges, top-bottom is what lays unconnected nodes out as a
 * row instead of a tall column.
 *
 * Returns null when there is nothing to draw — an empty diagram frame reads as a
 * broken renderer, and the caller has a sentence for "no dependents found".
 */
export declare function mermaidDiagram(r: BlastReport): string | null;
/**
 * The PR-comment body: diagram, then one table, then everything else collapsed.
 *
 * `root` is the repository the report was taken in. With it, the collapsed symbol
 * list quotes the line that reaches the diff — the same line the hosted page shows,
 * from the same helper. Without it the list is unchanged, so a caller that has no
 * checkout (a test, a piped report) loses nothing but the snippet.
 */
export declare function markdownReport(r: BlastReport, opts?: {
    root?: string;
}): string;
/** Terminal report: same content, no markdown scaffolding. */
export declare function textReport(r: BlastReport): string;
//# sourceMappingURL=render.d.ts.map