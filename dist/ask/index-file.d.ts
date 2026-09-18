import type { GraphV1 } from "../graph/types.js";
/** Split prose + identifiers into lowercased subword tokens (camelCase, snake, kebab).
 * The single source of truth for tokenization — shared by build-time indexing
 * (this file) and query-time fallback (`ask.ts`) so the sidecar is a provably
 * exact cache of the live path. */
export declare function tokenize(text: string): string[];
/** Term-frequency count map. */
export declare function counts(tokens: string[]): Map<string, number>;
/** One node's token bags, JSON-friendly (`Map` → sorted `[token, count][]`). */
export interface AskIndexDoc {
    id: string;
    name: [string, number][];
    path: [string, number][];
    body: [string, number][];
}
/** The build-time sidecar. `df`/`docCount` cover symbol+file nodes only (no
 * concepts — see module docstring); `avgBodyLen` is the BM25 corpus average. */
export interface AskIndex {
    version: 1;
    avgBodyLen: number;
    df: [string, number][];
    docCount: number;
    docs: AskIndexDoc[];
}
export declare const ASK_INDEX_FILE = "ask-index.json";
/** Absolute path to the ask sidecar for a context dir: `<dir>/.cache/ask-index.json`.
 * `.cache/` is the established uncommitted-cache location — this sidecar is a
 * derived, regenerate-anytime cache, not checked-in graph data. */
export declare function askIndexPath(outDir: string): string;
/**
 * Tokenize every node in `graph` (exactly as `ask.ts`'s lexical pass does) and
 * write the resulting bags + document frequencies to
 * `<outDir>/.cache/ask-index.json`. Returns the path written. Deterministic:
 * nodes are indexed in id order, so an unchanged graph produces a
 * byte-identical sidecar.
 */
export declare function writeAskIndex(outDir: string, graph: GraphV1): string;
/** Read the ask sidecar. Returns null on a missing file, unparseable JSON, an
 * unrecognized shape, an unknown `version`, or a `docCount` that doesn't match
 * the number of docs actually stored (a corrupted/truncated sidecar would
 * otherwise silently skew IDF) — any of which means the caller should fall
 * back to live tokenization, never crash or trust bad data. */
export declare function readAskIndex(outDir: string): AskIndex | null;
//# sourceMappingURL=index-file.d.ts.map