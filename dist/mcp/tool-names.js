/** Grafly MCP vocabulary; graft_* names are deprecated aliases. */
export const GRAFLY_MCP_TOOL_CANONICAL = [
  "grafly_find_code",
  "grafly_find_all",
  "grafly_trace_calls",
  "grafly_file_api",
  "grafly_repo_map",
  "grafly_check_freshness",
];
export const GRAFLY_MCP_TOOL_ALIASES = {
  graft_find_code: "grafly_find_code",
  graft_find_all: "grafly_find_all",
  graft_trace_calls: "grafly_trace_calls",
  graft_file_api: "grafly_file_api",
  graft_repo_map: "grafly_repo_map",
  graft_check_freshness: "grafly_check_freshness",
  graft_ask: "grafly_find_code",
  graft_grep: "grafly_find_all",
  graft_callers: "grafly_trace_calls",
  graft_skeleton: "grafly_file_api",
  graft_map: "grafly_repo_map",
  graft_check: "grafly_check_freshness",
  grafly_ask: "grafly_find_code",
  grafly_grep: "grafly_find_all",
  grafly_callers: "grafly_trace_calls",
  grafly_skeleton: "grafly_file_api",
  grafly_map: "grafly_repo_map",
  grafly_check: "grafly_check_freshness",
};
export const GRAFLY_MCP_TOOL_NAMES = new Set(
  [...GRAFLY_MCP_TOOL_CANONICAL, ...Object.keys(GRAFLY_MCP_TOOL_ALIASES)].map((n) => n.toLowerCase())
);
export function canonicalToolName(name) {
  return GRAFLY_MCP_TOOL_ALIASES[name] ?? name;
}
/** @deprecated external compatibility exports. */
export const GRAFT_MCP_TOOL_CANONICAL = GRAFLY_MCP_TOOL_CANONICAL;
export const GRAFT_MCP_TOOL_ALIASES = GRAFLY_MCP_TOOL_ALIASES;
export const GRAFT_MCP_TOOL_NAMES = GRAFLY_MCP_TOOL_NAMES;
