// One option contract for the resident entry shim and the full CLI.
export const residentCommands = ["ask", "grep", "build", "callers"];
export function cliOptions(program) {
    return program.option("--dir <path>", "context graph directory (default: <repo>/.grafly)")
        .option("--provider <name>", "LLM wire format: openai | anthropic | litellm | orcarouter (env GRAFLY_PROVIDER)")
        .option("--model <id>", "model id for the LLM pass (env GRAFLY_MODEL)")
        .option("--api-key <key>", "provider API key (env GRAFLY_API_KEY)")
        .option("--base-url <url>", "OpenAI-compatible endpoint URL (env GRAFLY_BASE_URL)");
}
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
        .option("--read-only", "write nothing: no refresh, sync or answer cache (env GRAFLY_READONLY=1)")
        .action((query, dir, opts) => action("ask", query, dir, opts));
    program.command("grep")
        .description("Search indexed source, ranked by graph connectivity")
        .argument("<pattern>").argument("[dir]")
        .option("-i, --ignore-case", "case-insensitive match")
        .option("--fixed", "literal string instead of regex")
        .option("--in <path>", "narrow to this indexed path prefix")
        .option("--json", "output as JSON")
        .option("--no-refresh", "answer from the graph as-is")
        .option("--read-only", "write nothing: no refresh, sync or answer cache (env GRAFLY_READONLY=1)")
        .action((query, dir, opts) => action("grep", query, dir, opts));
}

export function buildCommand(program) {
    return program
    .command("build")
    .description("Build .grafly/ from code and materials — wiring graph, document/PDF text and image references ($0, no key). " +
    "Add --deep for the LLM concept map + per-symbol summaries/crux.")
    .argument("[dir]", "repository root", ".")
    .option("--deep", "run the LLM pass: concept nodes (.grafly/*.md) + per-symbol summary/crux")
    .option("--vision", "read images and image-only PDF pages with the configured vision model (opt-in; may send image content to that provider)")
    .option("-e, --extensions <exts...>", 'code extensions to include (e.g. ".ts" ".py"); an extension with no parser is ignored with a warning that lists the supported set')
    .option("-j, --concurrency <n>", "files summarized in parallel during --deep (default 5)")
    .option("--no-reuse", "re-parse every file instead of replaying unchanged ones from the extraction cache")
    .option("--lsp", "add compiler-grade call edges via a language server if one is installed (opt-in, slower; e.g. rust-analyzer, clangd)")
    .option("--allow-partial", "exit 0 even when document extraction or the deep/vision pass failed (successful evidence is retained)")
    .option("--follow-submodules", "include initialized Git submodules recursively; persisted for later builds and automatic refreshes")
    .option("--no-follow-submodules", "exclude Git submodules; persisted for later builds and automatic refreshes (default)")
    .option("--follow-nested-repos", "include nested Git clones the index does not track (a multi-repo manifest checkout, or any repo cloned into the tree) " +
    "as ONE graph, so imports across them resolve; persisted for later builds and automatic refreshes")
    .option("--no-follow-nested-repos", "exclude untracked nested Git clones; persisted for later builds and automatic refreshes (default)")
    .option("--include-dir <name>", "override SKIP_DIRS for this repo's walks — repeatable (e.g. --include-dir build --include-dir tools); " +
    "persisted, so a later build (and the hooks/refresh path) include it without the flag; dot-dirs are never overridable", (val, prev) => [...prev, val], [])
    .option("--only-dir <path>", "only index files under this repo-relative path — repeatable; the wiring walk and the --deep " +
    "concept pass both honor it. Recorded in the graph fingerprint so a later build " +
    "(and the hooks/refresh path) walks the same set; everything outside the list is skipped", (val, prev) => [...prev, val], [])
    .option("--no-gitignore", "skip writing .grafly/ into .gitignore (same as GRAFLY_NO_GITIGNORE=1)")
    .option("--no-ignore", "skip writing .ignore for ripgrep re-admit (same as GRAFLY_NO_IGNORE=1)");
}

export function callersCommand(program) {
    return program
    .command("callers")
    .description("Who calls/references a symbol ($0, no LLM). --direction out gives callees (what it calls); --depth N (or all) walks transitively for full blast radius")
    .argument("<symbol>", "bare name, qualified (Class.method), or package-qualified (pkg.Fn)")
    .argument("[dir]", "repository root (default: nearest ancestor with a .grafly/ index)")
    .option("--direction <in|out>", 'edge direction: "in" = callers (default), "out" = callees')
    .option("-d, --depth <n>", 'walk transitively up to N hops for blast radius, or "all" for the full connected closure (default 1)')
    .option("--in <path>", "narrow matches to nodes at or under this path prefix")
    .option("--top <n>", "with multiple same-name matches, show only the circuit's top N (the rest are listed in the verdict line)")
    .option("--limit <n>", 'cap edge hits shown per match (default 100; "0" or "all" shows every hit)')
    .option("--json", "output as JSON")
    .option("--no-refresh", "skip the freshness check — answer from the graph as-is");
}
