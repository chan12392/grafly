/** Canonical Grafly MCP tool vocabulary. */
export declare const GRAFLY_MCP_TOOL_CANONICAL: readonly [
    "grafly_find_code",
    "grafly_find_all",
    "grafly_trace_calls",
    "grafly_file_api",
    "grafly_repo_map",
    "grafly_check_freshness"
];
export declare const GRAFLY_MCP_TOOL_ALIASES: Record<string, string>;
export declare const GRAFLY_MCP_TOOL_NAMES: ReadonlySet<string>;
export declare function canonicalToolName(name: string): string;
/** @deprecated compatibility exports. */
export declare const GRAFT_MCP_TOOL_CANONICAL: typeof GRAFLY_MCP_TOOL_CANONICAL;
export declare const GRAFT_MCP_TOOL_ALIASES: typeof GRAFLY_MCP_TOOL_ALIASES;
export declare const GRAFT_MCP_TOOL_NAMES: typeof GRAFLY_MCP_TOOL_NAMES;
