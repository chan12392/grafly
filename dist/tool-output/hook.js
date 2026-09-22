#!/usr/bin/env node
/** Route before tool selection, so normal host approvals/sandbox still apply. */
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

export function outputContext(event) {
    if (process.env.GRAFLY_TOOL_OUTPUT === "0" || !["SessionStart", "UserPromptSubmit"].includes(event?.hook_event_name)) return null;
    const entry = fileURLToPath(new URL("./cli.js", import.meta.url));
    const invoke = process.platform === "win32"
        ? `& '${process.execPath.replaceAll("'", "''")}' '${entry.replaceAll("'", "''")}'`
        : `'${process.execPath.replaceAll("'", "'\\''")}' '${entry.replaceAll("'", "'\\''")}'`;
    const context = `[Grafly tool_output] For noninteractive test commands, invoke ${invoke} run -- <executable> <args> through your normal shell tool (including tools.exec_command inside functions.exec). Example: run -- python -m unittest -v tests.test_example. MC removes recognized passing unittest/Node TAP/pytest details before you read the result. Raw stdout/stderr are archived; the receipt gives the raw directory and grafly output ID for retrieval. Keep original workdir, permissions and timeout. Preserve the runner exit code (PowerShell: append ; exit $LASTEXITCODE). Use ordinary tools for interactive/TTY, source reads and diffs. No session history is modified.`;
    return { hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext: context } };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    try {
        const raw = readFileSync(0, "utf8").replace(/^\uFEFF/, "");
        if (Buffer.byteLength(raw) <= 1024 * 1024) {
            const result = outputContext(JSON.parse(raw));
            if (result) process.stdout.write(JSON.stringify(result));
        }
    } catch { /* Invalid/unsupported hooks pass through, without changing permissions. */ }
}
