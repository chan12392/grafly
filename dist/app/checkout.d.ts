export interface CheckoutRequest {
    owner: string;
    repo: string;
    number: number;
    baseRef: string;
    token: string;
    api?: string;
    /** Where to say which of GitHub's two PR refs the review is actually using —
     * the App's own log callback, so the two cases are told apart in the container
     * logs rather than guessed at from the comment. */
    log?: (msg: string) => void;
}
export interface Checkout {
    /** Working tree at the pull request's merge commit, or at its head commit when
     * the merge ref is gone (see {@link ref}). */
    dir: string;
    /** What `blast --base` should diff against. */
    base: string;
    /** Which ref the tree came from. `merge` is the normal case; `head` means the
     * pull request is closed and GitHub has deleted its merge preview. */
    ref: "merge" | "head";
    /** Removes the tree. Always call it — the token's clone is not something to
     * leave in /tmp. */
    cleanup: () => void;
}
/**
 * Fetch the PR's code and its base, shallow, and land on it.
 *
 * `refs/pull/N/merge` is GitHub's own merge of the PR into its base — the same
 * thing the checks see, and the right thing to review: it is what will land, not
 * what the contributor's branch says in isolation. It is preferred whenever it
 * exists.
 *
 * But GitHub DELETES that ref the moment a pull request is closed or merged: it
 * is only a preview of a merge, and there is nothing left to preview afterwards.
 * Re-reviewing any merged PR therefore died at the fetch with `couldn't find
 * remote ref refs/pull/N/merge` — 16 in a row on one installation — which is why
 * `refs/pull/N/head` (the branch tip as the author pushed it, kept indefinitely
 * in the BASE repository, so it survives even the fork being deleted) is fetched
 * as a fallback. What changes with it is the diff basis, which
 * {@link headDiffBase} is entirely about.
 */
export declare function checkoutPullRequest(req: CheckoutRequest): Checkout;
/** What a plain-repository checkout needs: no pull request, just a ref. */
export interface RepoCheckoutRequest {
    owner: string;
    repo: string;
    /** Branch to read. Empty means "whatever HEAD points at" (the default branch). */
    ref?: string;
    token: string;
    /** How much history to fetch. The default is deeper than a PR review needs
     * because commit MESSAGES are the payload here, not a diff — 50 commits is a
     * fortnight on an active repo and would mine almost nothing. */
    depth?: number;
    api?: string;
    log?: (msg: string) => void;
}
/** A plain checkout: the tree, the commit it landed on, and the cleanup. */
export interface RepoCheckout {
    dir: string;
    headSha: string;
    /** The branch actually checked out, resolved when the caller named none. */
    branch: string;
    cleanup: () => void;
}
/**
 * Clone one repository at a ref, shallow, for reading rather than reviewing.
 *
 * Separate from {@link checkoutPullRequest} rather than a flag on it: that
 * function's whole shape — two refspecs, the merge/head fallback, the diff-base
 * resolution — exists to answer "what does this pull request change", and none
 * of it applies to "read this repository's history". Sharing the hardened `git`
 * runner is the part worth reusing.
 */
export declare function checkoutRepository(req: RepoCheckoutRequest): RepoCheckout;
/** Never let a token reach a log line, even inside git's own error text. */
export declare function redact(text: string, token: string): string;
//# sourceMappingURL=checkout.d.ts.map