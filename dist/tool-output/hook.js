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
    const context = `[Grafly tool_output] For noninteractive commands, invoke ${invoke} run -- <executable> <args> through your normal shell tool (including tools.exec_command inside functions.exec). Recognized forms: passing unittest/Node TAP/pytest details are removed (warnings, skips, totals remain); rg/grep/findstr/find/ls/where/tree/which, cat/head/tail and git grep|ls-files keep the first 200 lines with counts; git status|log|diff|show stay bounded while conflict/rename/status data remains; npm/pnpm/yarn install-family drops recognized noise lines only. Unrecognized output, errors and interrupted runs pass through raw. Keep original workdir, permissions and timeout. Preserve the runner exit code (PowerShell: append ; exit $LASTEXITCODE). For file contents or directory listings prefer ${invoke} read <path> [--start N --count N] or read <path> --find '<literal>' --context N — bounded path:line evidence, no shell needed. For omitted run details, use output <receipt-id> --find '<literal>' first (case-sensitive, both streams, 1 context line, at most 20 matches/8 KiB). Results show stream:line and match counts. If complete=false, continue only in the needed stream using --stream <name> --start <next_start>, or refine the literal. Use --context 0 for exact-name lookup; use --stream <name> --start <line> --count <lines> for a bounded raw excerpt. Retrieve only evidence needed for the question; do not dump entire archives or manifests or rerun commands to recover omitted details. Use ordinary tools for interactive/TTY commands; shell-wrapped invocations pass through unreduced. Raw output archives share a 20 MiB budget; active writers are protected and oldest completed records can expire. No session history is modified.`;
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
