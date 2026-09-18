import { type Savings } from "../context/savings.js";
import { type Direction, type EdgeHit } from "./traverse.js";
import type { GraphV1, NodeV1 } from "./types.js";
export interface CallersCliOptions {
    in?: string;
    json?: boolean;
    /** walk direction; defaults to "in" (callers). "out" gives callees. */
    direction?: string;
    /** max BFS depth, as the raw --depth string (validated here); defaults to 1. */
    depth?: string;
    /** the top-level `--dir` override, so this command respects it like every other. */
    globalDir?: string;
}
/** Exported so the MCP `graft_trace_calls` tool (`src/mcp/tools.ts`) can render the
 * same human report format as the CLI, rather than re-implementing it — both
 * surfaces walk the same edges via the same `resolveSymbol` / `edgeWalk` core. */
export declare function headerOf(n: NodeV1): string;
/** `showDepth` is set for multi-hop walks (depth > 1), matching the old
 * `graft impact` output which tagged every hit with its BFS depth.
 *
 * `quote`, when given, is the call site itself — the line inside the hit where it
 * references the symbol. An edge that says "total calls add" is a claim; the line
 * under it is the evidence, and it saves opening the file to check.
 */
export declare function hitLine(direction: Direction, hit: EdgeHit, showDepth: boolean, quote?: Quote): string;
/** A quoted source line: where the edge actually happens. */
interface Quote {
    n: number;
    text: string;
}
/** Tokens-saved baseline for a callers/callees walk: the files of the matched
 * symbols plus every resolved edge endpoint, read whole — the files you'd open
 * to trace these edges by hand. Shared by the CLI and the MCP tool so both
 * surfaces report the same number. */
export declare function callersSavings(graph: GraphV1, results: {
    symbol: NodeV1;
    hits: EdgeHit[];
}[]): Savings | undefined;
/** Loud, actionable empty-result note — never a bare empty list. `candidateCount`
 * is how many nodes {@link resolveSymbol} matched for this query (both call
 * sites already hold it as `matches.length`) — when it's >1, the query name is
 * itself ambiguous (several definitions share it), which is exactly the case
 * `resolve.ts` drops a cross-file call/reference for rather than guessing which
 * one it means. Without saying so, a zero-hit result here reads as "nothing
 * calls this" when it may really be "something does, but the edge was dropped". */
export declare function looseNoteFor(direction: Direction, name: string, candidateCount: number): string;
/**
 * Resolve `query` in the graph at `dir` (respecting `--dir`/`--in`), walk edges
 * per `--direction`/`--depth`, and print either the human report or `--json`.
 * Exits the process (code 1) when there's no graph at all or the symbol is
 * unknown — both are caller-facing mistakes, not recoverable states.
 */
export declare function runCallersCommand(query: string, dir: string, opts: CallersCliOptions): void;
export {};
//# sourceMappingURL=traverse-cli.d.ts.map