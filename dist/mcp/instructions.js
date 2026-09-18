const TOOL_ORDER = [
  "grafly_find_code",
  "grafly_find_all",
  "grafly_trace_calls",
  "grafly_file_api",
  "grafly_repo_map",
];
export function toolSearchQuery(prefix = "mcp__grafly__") {
  return `select:${TOOL_ORDER.map((t) => `${prefix}${t}`).join(",")}`;
}
export function mcpInstructions() {
  return [
    "This repo is indexed by Grafly: a local graph of symbols, file:line spans and call relations.",
    "Prefer Grafly tools over repeated grep/read calls when the graph can answer directly.",
    "",
    `If schemas are deferred, load all Grafly tools in one lookup: ToolSearch "${toolSearchQuery()}".`,
    "",
    "- grafly_find_code — ranked code/context lookup.",
    "- grafly_find_all — every indexed occurrence.",
    "- grafly_trace_calls — callers, callees and transitive blast radius.",
    "- grafly_file_api — signatures for one file.",
    "- grafly_repo_map — repository orientation.",
    "- grafly_check_freshness — graph drift status.",
    "",
    "Legacy graft_* names are accepted only as compatibility aliases.",
  ].join("\n");
}
