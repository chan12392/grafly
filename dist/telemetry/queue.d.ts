/**
 * The ceiling on the queue. An unflushable machine — permanently offline, or a
 * key that never works — must not grow a file in someone's home forever.
 *
 * Bytes are the bound, because size is the only thing cheap enough to check on
 * every append (one `statSync`); counting lines would mean reading the whole
 * file each time. {@link TRIM_TO_EVENTS} is not a second ceiling — it is how
 * FAR a trim cuts back, so a queue of unusually small events sheds a worthwhile
 * amount rather than one line at a time. Between trims the file can hold more
 * than that many events, and can exceed the byte bound by one append.
 */
export declare const MAX_QUEUE_BYTES: number;
export declare const TRIM_TO_EVENTS = 500;
export declare function queuePath(home?: string): string;
/**
 * Append one event. Never throws — a full disk or a read-only home must not fail
 * the command the user actually ran.
 */
export declare function enqueue(event: unknown, home?: string): void;
/**
 * Take everything pending, leaving an empty queue behind.
 *
 * The rename is what makes this safe against a concurrent append: from the
 * instant it returns, other processes are writing to a brand-new file. Malformed
 * lines are skipped rather than poisoning the batch — a torn write from a crash
 * mid-append should cost one event, not the whole queue.
 */
export declare function drain(home?: string): unknown[];
/** Read without draining, for `graft telemetry debug`. */
export declare function peek(home?: string): unknown[];
/** Put a failed batch back, so a flush that could not reach the network does not
 *  silently discard a week of events. Oldest-first, ahead of anything queued
 *  since the drain. */
export declare function requeue(events: unknown[], home?: string): void;
