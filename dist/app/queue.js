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
export class WorkQueue {
    run;
    pending = new Map();
    running = new Set();
    concurrency;
    onError;
    idle = [];
    constructor(run, opts = {}) {
        this.run = run;
        this.concurrency = Math.max(1, opts.concurrency ?? 2);
        this.onError = opts.onError ?? (() => { });
    }
    /**
     * Queue work under `key`, replacing anything queued under it and not yet started.
     *
     * A job already RUNNING is left alone: cancelling mid-clone buys nothing, and
     * the newer job simply runs after it and overwrites the comment.
     */
    push(key, item) {
        this.pending.set(key, item);
        this.pump();
    }
    get size() {
        return this.pending.size + this.running.size;
    }
    /** Resolves when nothing is queued or running — for tests and for shutdown. */
    async drain() {
        if (this.size === 0)
            return;
        await new Promise((resolve) => this.idle.push(resolve));
    }
    pump() {
        while (this.running.size < this.concurrency) {
            const next = this.pending.entries().next();
            if (next.done)
                break;
            const [key, item] = next.value;
            this.pending.delete(key);
            this.running.add(key);
            void this.run(item)
                .catch((err) => this.onError(err, key))
                .finally(() => {
                this.running.delete(key);
                this.pump();
                if (this.size === 0) {
                    const waiting = this.idle;
                    this.idle = [];
                    for (const resolve of waiting)
                        resolve();
                }
            });
        }
    }
}
//# sourceMappingURL=queue.js.map