/**
 * What arrived, and whether it is worth work.
 *
 * A busy installation delivers a lot of noise — labels, assignments, reviews —
 * and every accepted delivery costs a clone and a parse. Narrowing happens here,
 * once, so the queue only ever holds jobs that will produce a comment.
 */
/** The subset of a `pull_request` delivery this App reads. */
export interface ReviewJob {
    installationId: number;
    owner: string;
    repo: string;
    /** Base repository's full name, which is where the comment goes — a fork PR
     * carries a different head repo, and posting there would be posting on the
     * contributor's copy. */
    number: number;
    baseRef: string;
    headSha: string;
    /** True when the head branch lives in a fork: the PR's code is not ours. */
    fromFork: boolean;
}
/**
 * A delivery to act on, or null with the reason it was skipped.
 *
 * Draft pull requests are skipped deliberately: a draft is a work in progress and
 * a bot commenting on every push to one is the fastest way to be uninstalled.
 * `ready_for_review` is in the accepted set so the comment appears the moment the
 * author asks for eyes.
 *
 * A CLOSED pull request is not skipped. The graph is most useful to whoever reads
 * the PR later, and a merged PR is exactly what gets read — so the comment has to
 * keep working after the merge. This costs nothing on live traffic: none of the
 * four accepted actions fire on an already-merged PR, so in practice this only
 * admits a `synchronize` that raced a merge, and a deliberate re-delivery. The
 * accepted-action set, not the PR state, is what bounds the work.
 */
export declare function reviewJobFor(event: string, payload: unknown): {
    job: ReviewJob;
} | {
    skip: string;
};
/** Collapse queued work per pull request: only the newest push is worth reviewing. */
export declare const jobKey: (j: ReviewJob) => string;
//# sourceMappingURL=events.d.ts.map