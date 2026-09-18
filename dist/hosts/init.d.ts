import { type McpWrite } from './mcp-config.js';
import type { ConfigWrite } from './config-write.js';
export interface HostsInitResult {
    written: {
        id: string;
        path: string;
        action: string;
    }[];
    skipped: string[];
    unknown: string[];
    mcp: McpWrite[];
    hooks: ConfigWrite[];
}
export declare function runHostsInit(repo: string, opts?: {
    agents?: string[];
    all?: boolean;
    home?: string;
    mcp?: boolean;
    hooks?: boolean;
    /** false → skip every write outside the repo (the ~/.codex/ targets). */
    global?: boolean;
}): HostsInitResult;
//# sourceMappingURL=init.d.ts.map