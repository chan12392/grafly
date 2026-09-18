import type { GraphV1 } from "../graph/types.js";
import { type Savings } from "../context/savings.js";
export interface GrepHit {
    line: number;
    /** Trimmed line text, capped at 160 chars. */
    text: string;
}
export interface GrepSymbolRef {
    id: string;
    /** Qualified scope-joined name (e.g. `FastAPI.include_router`), not just
     * the bare symbol name — the id's segment after the file-path `#`. */
    name: string;
    kind: string;
    path: string;
    span: string;
}
export interface GrepGroup {
    /** null → file-level: the hit lies outside every indexed symbol's span
     * (module-level code — imports, top-level statements, module constants). */
    symbol: GrepSymbolRef | null;
    path: string;
    /** Incoming WALK_RELATIONS edges targeting the symbol — always 0 for
     * file-level groups (there's no single symbol id to count edges against). */
    inDegree: number;
    hits: GrepHit[];
}
export interface GrepResult {
    pattern: string;
    /** Indexed file nodes considered (after the `in` filter), whether or not
     * each was actually readable — matches the CLI's "searched N indexed
     * files" wording. */
    filesSearched: number;
    /** Hits actually collected (<= maxHits). */
    totalHits: number;
    /** Sorted: inDegree desc, then path asc. */
    groups: GrepGroup[];
    /** Dropped counts — never silent. `files`: indexed file nodes that
     * couldn't be read from disk. `hits`: matches found beyond `maxHits`,
     * counted but not collected. */
    truncated: {
        files: number;
        hits: number;
    };
    /** Tokens-saved baseline: the files that had hits, read whole. Undefined
     * when there were no hits or the graph predates file sizing. */
    saved?: Savings;
}
export interface GrepOptions {
    ignoreCase?: boolean;
    /** Treat `pattern` as a literal string (regex-escaped), not a regex. */
    fixed?: boolean;
    /** Narrow to file nodes at or under this repo-relative path prefix — the same
     * segment-aware rule `ask --in` and `callers --in` use. Either separator. */
    in?: string;
    /** Stop collecting hits after this many; the rest are tallied into
     * `truncated.hits`. Default 300. */
    maxHits?: number;
}
export declare function grepGraph(graph: GraphV1, repoRoot: string, pattern: string, opts?: GrepOptions): GrepResult;
//# sourceMappingURL=grep.d.ts.map