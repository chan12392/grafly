import { type SendResult } from './send.js';
/** Matches `UPDATE_TTL_MS`: a day is the natural period for both. */
export declare const FLUSH_TTL_MS: number;
export declare function needsFlush(flushedAt: number | undefined, now?: number): boolean;
/**
 * Spawn the flush if the queue has something in it and a day has passed. Returns
 * whether a child was started, for tests. Never waits, never throws.
 */
export declare function maybeFlushInBackground(home?: string, now?: number): boolean;
/**
 * Whether a failed send is worth keeping the batch for.
 *
 * A 5xx or a transport failure is ours to retry — a week offline should not be
 * a week of lost events. A 4xx is not: a bad key or a malformed batch will fail
 * identically forever, and retrying it would pin the queue at its cap until it
 * starts dropping the events that WOULD have sent.
 */
export declare function shouldRequeue(res: SendResult): boolean;
/** The `graft _telemetry-flush` body, running in the detached child. */
export declare function runFlush(home?: string): Promise<void>;
