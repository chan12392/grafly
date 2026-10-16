// One option contract for the resident entry shim and the full CLI.
export function searchCommands(program, action) {
    program.command("ask")
        .description("Query the graph for ranked nodes and exact file:line ($0, no key)")
        .argument("<query>").argument("[dir]")
        .option("-n, --limit <n>", "max results", "8")
        .option("--source", "inline source at each hit")
        .option("--full", "inline whole definition spans with --source")
        .option("--in <path>", "narrow to this indexed path prefix")
        .option("--json", "output as JSON")
        .option("--no-graph-rank", "rank by lexical relevance only")
        .option("--no-xerj", "use builtin retrieval")
        .option("--no-refresh", "answer from the graph as-is")
        .action((query, dir, opts) => action("ask", query, dir, opts));
    program.command("grep")
        .description("Search indexed source, ranked by graph connectivity")
        .argument("<pattern>").argument("[dir]")
        .option("-i, --ignore-case", "case-insensitive match")
        .option("--fixed", "literal string instead of regex")
        .option("--in <path>", "narrow to this indexed path prefix")
        .option("--json", "output as JSON")
        .option("--no-refresh", "answer from the graph as-is")
        .action((query, dir, opts) => action("grep", query, dir, opts));
}
