#!/usr/bin/env node
/** Small entry used by host hooks, without graph/LLM startup work. */
import { runCommand } from "./runner.js";

async function main() {
    const [mode, ...args] = process.argv.slice(2);
    let result;
    if (mode === "run" && args.length) {
        if (args[0] === "--") args.shift();
        if (!args[0]) throw new Error("missing command");
        result = await runCommand(args[0], args.slice(1));
    } else throw new Error("usage: grafly run -- <executable> [args...]");
    process.exitCode = result.exit_code;
}

if (import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1] ?? "").href)
    main().catch(error => { console.error(`grafly run: ${error.message}`); process.exitCode = 1; });
