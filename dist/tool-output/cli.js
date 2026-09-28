#!/usr/bin/env node
/** Small entry used by host hooks, without graph/LLM startup work. */
import { runCommand } from "./runner.js";
import { parseArgs } from "node:util";
import { writeOutput } from "./output.js";

async function main() {
    const [mode, ...args] = process.argv.slice(2);
    let result;
    if (mode === "run" && args.length) {
        let sessionId;
        if (args[0]?.startsWith("--session-id=")) {
            sessionId = args.shift().slice("--session-id=".length);
        } else if (args[0] === "--session-id") {
            if (args[1] === undefined || args[1] === "--") throw new Error("missing session id");
            args.shift(); sessionId = args.shift();
        }
        if (args[0] === "--") args.shift();
        if (!args[0]) throw new Error("missing command");
        result = await runCommand(args[0], args.slice(1), { sessionId });
    } else if (mode === "output-prune") {
        const { values } = parseArgs({ args, options: { "dry-run": { type: "boolean" } } });
        const { pruneArchives } = await import("./retention.js");
        process.stdout.write(JSON.stringify(pruneArchives({ dryRun: Boolean(values["dry-run"]) }), null, 2) + "\n");
    } else if (mode === "output") {
        const { values, positionals } = parseArgs({ args, allowPositionals: true, options: Object.fromEntries(
            ["stream", "start", "count", "archive-dir", "find", "context", "max-matches", "max-bytes"].map(name => [name, { type: "string" }])) });
        if (positionals.length !== 1) throw new Error("usage: grafly output <id> [--find <literal>]");
        const options = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
        writeOutput(positionals[0], options);
    } else if (mode === "read") {
        const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
            ...Object.fromEntries(["start", "count", "find", "context", "max-matches", "max-bytes", "session-id"].map(name => [name, { type: "string" }])),
            fresh: { type: "boolean" },
        } });
        if (positionals.length !== 1) throw new Error("usage: grafly read <path> [--start N --count N | --find <literal>]");
        const options = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
        const { readPath } = await import("./output.js");
        process.stdout.write(readPath(positionals[0], options));
    } else throw new Error("usage: grafly run -- <executable> [args...] | grafly output <id> [--find <literal>] | grafly read <path> | grafly output-prune [--dry-run]");
    process.exitCode = result?.exit_code ?? 0;
}

if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1] ?? "").href)
    main().catch(error => { console.error(`grafly: ${error.message}`); process.exitCode = 1; });
