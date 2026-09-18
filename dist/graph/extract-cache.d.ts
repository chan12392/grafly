import type { RawEdge } from "./extract.js";
import type { NodeV1 } from "./types.js";
export declare const EXTRACT_CACHE_PREFIX = "extract";
export interface ExtractEntry {
    size: number;
    mtimeMs: number;
    /** sha256 of the file's bytes — the same value as its `kind:"file"` node's `body_hash`. */
    hash: string;
    nodes: NodeV1[];
    rawEdges: RawEdge[];
    /** Set when this file couldn't be read or parsed. The entry exists anyway so the
     * freshness probe doesn't flag the file as new on every query; replaying it
     * re-reports the same error and contributes no nodes, exactly as a cold build
     * would. */
    error?: string;
}
export interface ExtractCache {
    version: number;
    /** Identity of the extractor that produced these entries. */
    extractor: string;
    /** repo-relative source path → its last parse. */
    files: Record<string, ExtractEntry>;
}
/**
 * Where this graft's memo lives: `<outDir>/.cache/extract.<stamp>.json`.
 *
 * The stamp is in the *filename*, not just inside the file, so two grafts working
 * on one repo keep separate memos instead of evicting each other. That is the
 * default install, not an exotic case: `graft init` wires the MCP server as
 * `npx -y @nanonets/graft` (which resolves the latest published version) while the
 * Claude Code hooks run the locally installed one. The moment those two versions
 * differ, a single shared file means the prompt hook and every MCP retrieval take
 * turns rejecting each other's entries and cold-re-parsing the whole repo — the memo
 * would never help anyone.
 *
 * Null stamp → null path → no memo at all. See {@link extractorStamp}.
 */
export declare function extractCachePath(outDir: string): string | null;
/** Keep `.cache/` from growing a file per version forever: after writing, drop all
 * but the newest `keep` files sharing a prefix. Best-effort and never fatal — this
 * is a cache directory, and a failure here costs disk, not correctness. */
export declare function pruneSidecars(cacheDir: string, prefix: string, keep?: number): void;
/**
 * Identity of the code that produces the cached parses. Both sidecars key on it,
 * so *anything* that can change extraction output has to change this string.
 *
 * Content-hashed over every sibling module in this directory, plus the package
 * version. Two earlier instincts are deliberately rejected:
 *
 * - **Not a timestamp.** This was `mtime:size` of `extract.js` alone, which is
 *   wrong in both directions. Too loose: the parse of `db.count()` depends on
 *   `bindings.ts` deciding that `db` is a `UserRepo` (that answer is stored *in*
 *   the cached entry, as an edge's `recvType`), and fixing a binding bug leaves
 *   `extract.js`'s emitted bytes untouched — so any build that skips rewriting
 *   unchanged output keeps the old stamp and silently replays pre-fix edges. Too
 *   tight: a rebuild that rewrites identical content moves the mtime and throws
 *   away the whole memo for nothing.
 * - **Not a hand-kept list of modules.** A list is correct exactly until someone
 *   moves parse logic into a module nobody added to it, and the failure is silent.
 *
 * Hashing the directory over-invalidates a little — editing any `graph/` module
 * costs one cold rebuild — which is no more often than a version bump already
 * costs, and always in the safe direction. The package version is folded in so a
 * tree-sitter grammar upgrade (which changes parse output without changing any of
 * graft's own files) invalidates too.
 *
 * Measured at ~0.5ms for 21 files / 556KB, paid once per process.
 *
 * **Null when no identity can be established at all**, and that is deliberately not
 * a string. It used to return `"unknown"` on failure — but `"unknown"` was then
 * *written into the sidecars as a real identity*, and every later run compared equal
 * to it, so any environment where stamping fails (a `pkg`/`bun-compile` single-file
 * build, an asar-style read, a directory that can't be listed) permanently lost the
 * ability to notice an extractor change. A sentinel that doubles as a valid value
 * silently disables the whole mechanism. Null forces callers to decide instead, and
 * {@link extractCachePath} decides not to have a memo.
 */
export declare function extractorStamp(): string | null;
/**
 * Hash every `ext` file in `dir`, plus `version`. Null when the directory holds no
 * such file. Separated from {@link extractorStamp} so a test can prove the property
 * that matters: a change to *any* module in the directory moves the stamp, not just
 * the one the old implementation happened to watch.
 */
export declare function stampDir(dir: string, ext: string, version?: string): string | null;
export declare function emptyExtractCache(): ExtractCache;
/** The cache for `outDir`, or an empty one when it's absent, unparseable, written by
 * a different cache version, or when this graft has no identity to key on (then
 * every build is cold, which is slow but never wrong). The stamp is in the filename,
 * so the `extractor` field is a second check rather than the only one. */
export declare function readExtractCache(outDir: string): ExtractCache;
/** Best-effort write — a full graph is already on disk by the time this runs, so an
 * unwritable cache dir must never fail the build (it only costs the next build its
 * reuse). Returns false when nothing was written, including the deliberate case of
 * having no extractor identity: a parse we can't attribute must never be replayed. */
export declare function writeExtractCache(outDir: string, cache: ExtractCache): boolean;
//# sourceMappingURL=extract-cache.d.ts.map