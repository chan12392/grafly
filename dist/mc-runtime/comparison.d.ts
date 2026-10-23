export interface ComparisonTool {
    name: string;
    arguments: Record<string, unknown>;
    scope: string;
    effects: ('read' | 'write' | 'delete' | 'execute' | 'network')[];
    purpose: string;
}
export interface ComparisonItem {
    id: string; text: string; protected: boolean;
    constraint_status: 'satisfied' | 'violated' | 'unknown';
    role?: 'instruction' | 'constraint' | 'failure' | 'definition' | 'explanation' | 'other';
    requires?: string[];
    tool?: ComparisonTool;
}
export declare function observeComparison(event: Record<string, unknown>, options?: {
    cwd?: string; sessionId?: string; env?: NodeJS.ProcessEnv;
}): Promise<{ status: string; reason?: string; job_id?: string }>;
export declare function outputItems(stdout: string, stderr: string, failed?: boolean): ComparisonItem[];
