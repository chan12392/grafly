import { type AgentHost } from './contract.js';
/** Untouched for this long and the session is treated as over. */
export declare const SESSION_IDLE_MS: number;
/**
 * Roll one session up into a `session_summary`, ignoring the idle gate — for a
 * host with a real end-of-session signal (Cursor's `sessionEnd`). Returns 1 if
 * queued, 0 if already summarised or telemetry is off. Never throws.
 *
 * The event is attributed to the host stamped on the session file when there is
 * one (a session used from Cursor stays Cursor even if Claude's idle sweep is
 * what finally flushes it); `opts.host` is only the fallback for a file written
 * before host-stamping, or by a path that didn't stamp.
 */
export declare function summarizeSession(repo: string, id: string, opts?: {
    host?: AgentHost;
    home?: string;
    env?: NodeJS.ProcessEnv;
}): number;
/**
 * Queue a `session_summary` for every closed, not-yet-summarised session in this
 * repo. "Closed" = untouched for {@link SESSION_IDLE_MS}. Returns how many were
 * queued (for tests). Never throws.
 */
export declare function flushClosedSessions(repo: string, now?: number, home?: string, env?: NodeJS.ProcessEnv, host?: AgentHost): number;
