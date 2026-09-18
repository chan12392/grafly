import { type VizGraph } from "./assemble.js";
export interface VizExportOptions {
    contextDir: string;
    /** Where index.html, app.js and style.css were bundled (dist/viewer). */
    viewerDir: string;
    /** Directory to write index.html into. Created if absent. */
    outDir: string;
    repoName: string;
    /** Shown in the appbar beside the repo name — e.g. "PR #151". */
    subtitle?: string;
    /**
     * Context graph to inline instead of assembling one from the deep tier's concept
     * files. `graft blast --export-viz` passes the blast radius itself, which is how a
     * PR gets a Context tab worth opening without a `--deep` build.
     */
    contextGraph?: VizGraph;
    /**
     * Tabs the page offers. Default: all three.
     *
     * A blast page passes `["context"]`. The Code tab there is the repo's whole
     * wiring graph — 1,377 nodes on graft itself, a hairball that answers nothing
     * about the pull request, and ~95% of the exported megabyte — and Outline is the
     * repo's file tree. Dropping them makes the page a tenth of the size and removes
     * two tabs a reviewer has no reason to open.
     */
    tabs?: Array<"context" | "code" | "outline">;
}
export interface VizExportResult {
    file: string;
    bytes: number;
    contextNodes: number;
    codeNodes: number;
    /** Tab the exported page opens on — see the reasoning in {@link exportViz}. */
    defaultTab: "context" | "code";
    /** Tabs written into the page. */
    tabs: Array<"context" | "code" | "outline">;
}
export declare function exportViz(opts: VizExportOptions): VizExportResult;
//# sourceMappingURL=export.d.ts.map