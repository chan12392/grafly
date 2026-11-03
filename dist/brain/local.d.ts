import type { ChatModel } from '../ai/llm/types.js';
import type { BrainLink } from './link.js';
export declare const MINING_INTERVAL_MS: number;
export interface LocalBrainState {
    status: 'idle' | 'disabled' | 'queued' | 'running' | 'unchanged' | 'complete' | 'error' | 'needs-model' | 'busy' | 'discarded';
    runId?: string;
    checkedAt?: number;
    startedAt?: number;
    completedAt?: number;
    lastSuccessAt?: number;
    pid?: number;
    log?: string;
    inputHash?: string;
    added?: number;
    total?: number;
    error?: string;
    exitCode?: number;
}
export declare function localBrainState(repo: string): LocalBrainState | null;
export declare function configureLocalBrain(repo: string, opts?: { background?: boolean; contextDir?: string }): {
    link: BrainLink; ruleCount: number; migrated: boolean;
};
export declare function scheduleLocalBrain(repo: string, now?: number): boolean;
export declare function mineLocalBrain(repo: string, opts?: {
    background?: boolean; jobId?: string; home?: string; model?: ChatModel; contextDir?: string;
}): Promise<LocalBrainState>;
