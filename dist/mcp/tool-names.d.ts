/**
 * The graft MCP tool names, kept in a zero-import module so both the MCP server
 * (which also pulls in the whole engine) and the session-scoring hooks (which must
 * stay cheap and engine-free) can share one list. Adding a dependency here would
 * drag it into every hook invocation, so this file imports nothing.
 */
/** The tools graft advertises today, as their canonical names. */
export declare const GRAFT_MCP_TOOL_CANONICAL: readonly ["graft_find_code", "graft_find_all", "graft_trace_calls", "graft_file_api", "graft_repo_map", "graft_check_freshness"];
/**
 * The pre-0.8.1 tool names, still accepted. A name is an API: skills, saved
 * prompts and other people's notes reference the old ones, so they map to the
 * canonical name rather than 404.
 */
export declare const GRAFT_MCP_TOOL_ALIASES: Record<string, string>;
/** Every name graft answers to (canonical + legacy), lower-cased, for a membership
 *  test that anchors on the real vocabulary instead of a loose `includes('graft')`. */
export declare const GRAFT_MCP_TOOL_NAMES: ReadonlySet<string>;
/** Canonical name for a requested tool: itself, or what it was renamed to. */
export declare function canonicalToolName(name: string): string;
//# sourceMappingURL=tool-names.d.ts.map