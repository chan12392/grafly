import { type ReviewJob } from "./events.js";
import type { reviewPullRequest, ReviewResult } from "./review.js";
/** Parent → child, once, immediately after the fork. */
export interface StartMessage {
    t: "start";
    job: ReviewJob;
    /** Minted by the parent; the child never sees the App's private key. */
    token: string;
    api?: string;
}
/** Parent → child: the URL a `publish` request ended up at, or null. */
export interface PublishedMessage {
    t: "published";
    seq: number;
    url: string | null;
}
export type ToChild = StartMessage | PublishedMessage;
/** Child → parent: a line for the App's log, so a review is still traceable. */
export interface LogMessage {
    t: "log";
    msg: string;
}
/** Child → parent: store this page and tell me its URL. */
export interface PublishMessage {
    t: "publish";
    seq: number;
    html: string;
}
export interface DoneMessage {
    t: "done";
    result: ReviewResult;
}
export interface FailedMessage {
    t: "failed";
    message: string;
}
export type FromChild = LogMessage | PublishMessage | DoneMessage | FailedMessage;
export interface ChildReviewerOptions {
    /** The module the child runs. Only tests pass this. */
    entry?: string;
    timeoutMs?: number;
}
/**
 * The module a review runs in.
 *
 * `dist/app/review-worker.js` in an installed or containerised App. Run from a
 * checkout there is no `dist`, so fall back to the TypeScript source next door:
 * `fork` inherits `process.execArgv`, so a parent started through tsx hands the
 * child the same loader and a `.ts` entry runs. Resolved once, at import.
 *
 * Exported so a test can assert the path a deployed App will fork actually exists —
 * getting this wrong is the one failure here that no unit test of the protocol
 * would catch and every review would hit.
 */
export declare function reviewWorkerEntry(): string;
/**
 * A reviewer with `reviewPullRequest`'s signature that runs it in a child process.
 *
 * Same shape on purpose: `server.ts` swaps one for the other in a single line, and
 * every existing test that injects its own reviewer through `AppSeams.review` keeps
 * running in-process, which is what a test wants.
 */
export declare function childReviewer(opts?: ChildReviewerOptions): typeof reviewPullRequest;
/** The App's default reviewer. */
export declare const reviewInChildProcess: typeof reviewPullRequest;
//# sourceMappingURL=review-process.d.ts.map