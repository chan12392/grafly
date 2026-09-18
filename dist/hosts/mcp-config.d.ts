import type { PlannedWrite } from './plan.js';
import { type ConfigWrite } from './config-write.js';
/** MCP registration reports the same write-result record every installer does. */
export type McpWrite = ConfigWrite;
/** A planned MCP write, plus the detail needed to actually perform it. */
export interface McpTarget extends PlannedWrite {
    format: 'json' | 'toml';
    /** JSON only: the top-level key holding the server map. */
    topKey?: string;
    /** JSON only: the server entry to merge in under `graft`. */
    entry?: object;
}
/**
 * JSON hosts: `{ command, args }`.
 *
 * `GRAFT_MCP_NPX=1` forces the `npx` form — the escape hatch for a machine whose
 * global install is stale or shadowed, and what the tests set so their expectations
 * don't depend on whether the machine running them happens to have graft installed.
 * `opts.onPath` is the same override for direct unit tests of both branches.
 */
export declare function serverEntry(opts?: {
    onPath?: boolean;
}): {
    command: string;
    args: string[];
};
export declare function mergeJsonKey(id: string, path: string, topKey: string, entry: object): McpWrite;
/**
 * Remove the `[mcp_servers.graft]` table from a TOML config, returning the rest.
 *
 * Line-based on purpose: a real parse-and-reserialize would reformat the user's
 * whole file. The table runs from its header to the next `[`-header or EOF, which
 * is exactly the shape {@link upsertCodexToml} appends. Exported so the writer and
 * `retract.ts` can never disagree about what "graft's section" means.
 */
export declare function stripTomlSection(text: string): {
    rest: string;
    found: boolean;
};
/**
 * The MCP config files selecting these hosts would touch — pure, no writes.
 * Codex's target is the user-level `~/.codex/config.toml`, so it is scoped
 * 'global': registering there affects every project on the machine.
 */
export declare function mcpTargets(repo: string, ids: string[], opts?: {
    home?: string;
}): McpTarget[];
export declare function registerMcpConfigs(repo: string, ids: string[], opts?: {
    home?: string;
    global?: boolean;
}): McpWrite[];
//# sourceMappingURL=mcp-config.d.ts.map