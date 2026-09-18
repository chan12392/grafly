/**
 * `graft init`'s closing epilogue: the ASCII wordmark + numbered next steps,
 * printed to stderr after the per-file ✓/·/⚠ lines. Extracted out of cli.ts
 * so the exact text — spacing is hand-aligned, not incidental — can be
 * unit-tested without spawning the CLI.
 */
export interface InitEpilogueOptions {
    /** Whether a graft graph exists on disk (built by this run, or a prior one). */
    graphBuilt: boolean;
    /** Node count from the built graph — only meaningful when `graphBuilt`. */
    nodes?: number;
    /** Edge count from the built graph — only meaningful when `graphBuilt`. */
    edges?: number;
}
/** Renders the `graft init` next-steps epilogue (no trailing newline — the
 * caller's `console.error` adds the one trailing newline). */
export declare function formatInitEpilogue(opts: InitEpilogueOptions): string;
//# sourceMappingURL=cli-epilogue.d.ts.map