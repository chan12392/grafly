export interface ModuleIndex {
    /** Label for a repo-relative path — a concept name when one claims the file. */
    labelOf(path: string): string;
    /** The claiming concept's name, or null when only the directory fallback applies.
     * Callers that group files need to tell the two apart: a shared concept is a real
     * grouping signal, a shared directory is only a shared directory. */
    conceptOf(path: string): string | null;
    /** True when at least one concept node was read (i.e. a --deep graph). */
    hasConcepts: boolean;
}
/**
 * Build the path → module-label lookup for a context dir.
 *
 * A file can be cited by several concepts; the SMALLEST claiming concept wins.
 * A concept grounded in three files says something specific about those three,
 * while a forty-file concept is closer to "the codebase" — picking the tighter
 * one keeps the diagram's boxes meaningful.
 */
export declare function moduleIndex(contextDir: string): ModuleIndex;
/**
 * A concept name trimmed to fit a node.
 *
 * Concept names are written for a reader with the whole file in front of them, so
 * they run long and some carry a `Concept: ` prefix from the synthesis prompt.
 * "Reciprocal-Rank Fusion for Workspace Federation" is a fine node title in `graft
 * viz` and unreadable inside a circle.
 */
export declare function shortLabel(label: string): string;
/** The parent directory of a directory label, or "" at the top level. */
export declare function parentDir(dir: string): string;
/** Fallback label: the file's directory, or `(root)` for a top-level file. */
export declare function dirLabel(path: string): string;
//# sourceMappingURL=modules.d.ts.map