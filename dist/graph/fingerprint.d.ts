import { type ExtractEntry } from "./extract-cache.js";
export declare const FINGERPRINT_PREFIX = "fingerprint";
/** `[size, mtimeMs, hash]` — positional to keep the file small. */
type Print = [number, number, string];
export interface Fingerprint {
    version: number;
    /** The extractor that produced the graph these prints describe — the same stamp
     * `extract.json` carries. Without it the two sidecars can disagree about whether
     * the graph is current: an extractor change correctly drops every memo entry,
     * yet the prints still match the tree byte-for-byte, so the probe would report
     * clean and queries would keep answering from nodes the old extractor built. */
    extractor: string;
    files: Record<string, Print>;
    /** Repo-relative directory prefixes this build was limited to (`--only-dir`).
     * Absent = full tree. Recorded here — not in the source repo's `.graft/config.json`
     * — so the query-path freshness probe (which never sees a CLI flag) enumerates the
     * identical whitelisted set and excluded files are never phantom "added" drift. */
    onlyDirs?: string[];
}
/** What moved since the last build. Empty in all three arrays = nothing to do. */
export interface Drift {
    /** Recorded files whose bytes differ now. */
    changed: string[];
    /** Source files with no record — new, or never indexed. */
    added: string[];
    /** Recorded files that are gone from disk. */
    removed: string[];
}
/** `<outDir>/.cache/fingerprint.<stamp>.json` — keyed by extractor identity for the
 * same reason the memo is (see {@link extractCachePath}): two grafts on one repo,
 * typically an `npx` MCP server and a locally installed hook binary, must not keep
 * invalidating each other's prints and forcing a cold rebuild on every call. */
export declare function fingerprintPath(outDir: string): string;
export declare function readFingerprint(outDir: string): Fingerprint | null;
/** Project the extraction cache's entries into the probe sidecar. Best-effort:
 * the graph is already on disk when this runs, so a failed write costs the next
 * probe its fast path and nothing more. */
export declare function writeFingerprint(outDir: string, entries: Record<string, ExtractEntry>, onlyDirs?: string[]): boolean;
/** `GRAFT_REFRESH=hash` — never trust a stat, confirm every file by its bytes. */
export declare function alwaysHash(): boolean;
/**
 * May a recorded `(size, mtimeMs, hash)` be trusted for the file `f` as it is on
 * disk now, without reading it?
 *
 * **The probe's rule only.** `buildGraph` deliberately does not use this: it reads
 * and hashes every file, every time. A stat may decide whether a query bothers
 * rebuilding; it may not decide what the rebuild itself looks at — otherwise
 * `graft check` (which always re-hashes) can report drift that the `graft build` it
 * recommends then refuses to repair. `GRAFT_REFRESH=hash` is the escape hatch for
 * the probe's blind spot: a same-length edit inside one mtime tick.
 *
 * An empty `hash` means the last build never got the bytes — always re-read.
 * A *parse* failure keeps its real hash, so it stays on the fast path: re-reading
 * bytes that failed to parse yesterday just fails to parse again.
 */
export declare function statUnchanged(rec: {
    size: number;
    mtimeMs: number;
    hash: string;
}, f: {
    size: number;
    mtimeMs: number;
}): boolean;
export declare function isClean(d: Drift): boolean;
export declare function driftCount(d: Drift): number;
/**
 * Diff the working tree against the last build's fingerprint. Returns null when
 * there is no fingerprint to compare against (never built, or built by a version
 * that didn't write one) — callers should treat that as "unknown", not "clean".
 *
 * `GRAFT_REFRESH=hash` skips the stat fast path and hashes every file, for the
 * rare tooling that rewrites content while preserving size and mtime.
 */
export declare function probeDrift(root: string, outDir: string): Drift | null;
export {};
//# sourceMappingURL=fingerprint.d.ts.map