import { type GlobalWrite } from '../hosts/claude-global.js';
import { type McpWrite } from '../hosts/mcp-config.js';
import type { PlannedWrite } from '../hosts/plan.js';
/**
 * The files `runInit` writes — pure, no writes, so `--dry-run` and the picker
 * can report them up front. All repo-local: the Claude Code layer never writes
 * outside the project.
 */
export declare function claudeTargets(dir: string): PlannedWrite[];
/**
 * Build the graph if it isn't there yet. Not Claude-specific: the wiring for any
 * host points at `graft/`, so `graft init` builds whichever hosts were selected —
 * this lives beside `runInit` only because that's the caller that owns `built`.
 * Best-effort; the user can always run `graft build` (the epilogue says so).
 */
export declare function buildGraphIfMissing(dir: string, opts: {
    build?: boolean;
    cliPath?: string;
}): boolean;
export interface InitResult {
    settingsPath: string;
    shims: string[];
    skill: string;
    /** the `.mcp.json` write registering the graft MCP server for Claude Code. */
    mcp: McpWrite;
    /** the user-level writes under `~/.claude`, empty when `global: false`. */
    global: GlobalWrite[];
    warnings: string[];
    built: boolean;
}
export declare function runInit(dir: string, opts?: {
    build?: boolean;
    cliPath?: string;
    statusline?: boolean;
    global?: boolean;
    home?: string;
}): InitResult;
//# sourceMappingURL=init.d.ts.map