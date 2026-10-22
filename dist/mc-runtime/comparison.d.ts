export declare function observeComparison(event: Record<string, unknown>, options?: {
    cwd?: string; sessionId?: string; env?: NodeJS.ProcessEnv;
}): Promise<{ status: string; reason?: string; job_id?: string }>;
export declare function outputItems(stdout: string, stderr: string, failed?: boolean): {
    id: string; text: string; protected: boolean; constraint_status: string;
}[];
