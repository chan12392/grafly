export interface SendResult {
    ok: boolean;
    status?: number;
    /** Why it failed, for `graft telemetry debug` only — never itself reported. */
    error?: string;
}
/**
 * The events as PostHog wants them — everything the wire body contains EXCEPT
 * the project key.
 *
 * The key is deliberately not in here. `graft telemetry debug` prints this
 * object so a user can audit exactly what graft sends, and a command that exists
 * to be pasted into a bug report must not also paste our ingestion key into it.
 * `sendBatch` adds the key at the moment of the request and nowhere else, which
 * keeps the key entirely out of every code path that can reach a terminal.
 */
export declare function buildBatch(events: unknown[]): Record<string, unknown>;
export declare function sendBatch(events: unknown[]): Promise<SendResult>;
