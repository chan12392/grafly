/**
 * The work queue.
 *
 * A webhook must be answered in seconds, and a review takes tens of them, so the
 * HTTP handler's only job is to enqueue. Two properties matter and neither comes
 * free from a bare array:
 *
 *  - **Superseding.** Five pushes to one pull request in a minute is normal, and
 *    reviewing the first four is wasted work whose comments are immediately
 *    overwritten. A queued job for the same PR is replaced, not appended.
 *  - **A ceiling.** One repository must not be able to starve every other
 *    installation, so a fixed number of workers drain the queue.
 */
export interface QueueOptions {
    concurrency?: number;
    /** Called for every failure: a job that throws must not take the process down,
     * and a silent catch would hide a broken installation forever. */
    onError?: (err: unknown, key: string) => void;
}
export declare class WorkQueue<T> {
    private readonly run;
    private readonly pending;
    private readonly running;
    private readonly concurrency;
    private readonly onError;
    private idle;
    constructor(run: (item: T) => Promise<void>, opts?: QueueOptions);
    /**
     * Queue work under `key`, replacing anything queued under it and not yet started.
     *
     * A job already RUNNING is left alone: cancelling mid-clone buys nothing, and
     * the newer job simply runs after it and overwrites the comment.
     */
    push(key: string, item: T): void;
    get size(): number;
    /** Resolves when nothing is queued or running — for tests and for shutdown. */
    drain(): Promise<void>;
    private pump;
}
//# sourceMappingURL=queue.d.ts.map