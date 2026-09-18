import { canonicalToolName } from './tool-names.js';
export interface ToolDef {
    name: string;
    description: string;
    inputSchema: object;
}
export declare const TOOLS: ToolDef[];
/**
 * The pre-0.8.1 tool names, still accepted, live in the dependency-free
 * `tool-names.ts` (shared with the engine-free session hooks). The names were the
 * reason for renaming: when a host defers graft's schemas it shows the model the
 * *names alone* — no descriptions — so `graft_ask` had to compete with `Grep` on
 * 9 characters. The new names say what they do; the aliases keep old callers
 * (skills, saved prompts, notes) from 404-ing. Re-exported here so existing
 * importers of `canonicalToolName` from this module keep working.
 */
export { canonicalToolName };
export declare function callTool(root: string, requestedName: string, args: Record<string, unknown>, dirOverride?: string): Promise<{
    text: string;
    isError: boolean;
}>;
//# sourceMappingURL=tools.d.ts.map