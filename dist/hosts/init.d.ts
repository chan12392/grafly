import type { ConfigWrite } from './config-write.js';
export interface HostsInitResult {
    written: {
        id: string;
        path: string;
        action: string;
    }[];
    skipped: string[];
    unknown: string[];
    hooks: ConfigWrite[];
}
export declare function runHostsInit(repo: string, opts?: {
    agents?: string[];
    all?: boolean;
    home?: string;
    hooks?: boolean;
    /** false → skip every write outside the repo (the ~/.codex/ targets). */
    global?: boolean;
}): HostsInitResult;
