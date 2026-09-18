import type { BlastReport } from "./blast.js";
/** One person's claim on one area. */
export interface Owner {
    /** Display name as git reports it, with `.mailmap` already applied. */
    name: string;
    /** GitHub handle, when the commit email carries one. Never guessed. */
    handle?: string;
    /** Commits of theirs that touched this area's files. */
    commits: number;
    /** Recency-weighted weight of those commits — the ranking key. */
    score: number;
    /** Their most recent commit here, ms since the epoch. */
    last: number;
}
/** One person's claim across the whole report: what the tag line prints. */
export interface Reviewer extends Owner {
    /** Area labels they own, heaviest first. */
    areas: string[];
}
export interface OwnerOptions {
    /** Logins, names or emails to drop — the PR author, so they are not told to
     * tag themselves. Matched case-insensitively against all three. */
    exclude?: string[];
    /** Clock, so a test can plant history at a fixed distance from "now". */
    now?: number;
}
/** Names listed per area, and in the tag line. */
export declare const MAX_PER_AREA = 2;
export declare const MAX_REVIEWERS = 3;
/**
 * A GitHub handle out of a commit email, or null.
 *
 * Both noreply forms are accepted: the modern `12345+name@` and the legacy bare
 * `name@`. The character class is GitHub's own username rule (alphanumerics and
 * interior hyphens, 39 max) so an address that merely ends in the right domain
 * cannot smuggle something unmentionable into a comment body.
 */
export declare function githubHandle(email: string): string | null;
/**
 * The people behind `files`, best first.
 *
 * `--no-merges` because a merge commit's author is whoever pressed the button,
 * not whoever wrote the code. `%aN`/`%aE` rather than `%an`/`%ae` so git applies
 * the repository's `.mailmap` for us — which is the supported way to give a
 * contributor whose work address has no handle a noreply one, at no new config
 * cost to graft.
 */
export declare function ownersFor(root: string, files: string[], opts?: OwnerOptions): Owner[];
/**
 * Everyone who authored a commit in `base...HEAD` — the people whose work this
 * pull request IS.
 *
 * This is the exclusion that actually fires in CI. The obvious source for "who
 * opened this" is `pull_request.user.email` from the webhook, but GitHub almost
 * never populates it, so excluding on the login alone leaves anyone whose commits
 * carry a work address being suggested as a reviewer of their own PR. The commits
 * in the range carry exactly the name and email git will match on later.
 *
 * Co-authors count too: a pair-programmed commit has two people on it and neither
 * of them is a reviewer of it.
 */
export declare function diffAuthors(root: string, base: string): string[];
/**
 * Whoever git would sign a commit as, here and now.
 *
 * The local counterpart of {@link diffAuthors}. `graft blast` with no `--base`
 * compares the working tree against HEAD, so there is no commit range to read
 * authors from — and without this, the one person guaranteed to have written the
 * change being examined is also the top name in its own "who to tag" list.
 */
export declare function localIdentity(root: string): string[];
/**
 * Fill in `owners` on every area and module, and rank the report's `reviewers`.
 *
 * Called AFTER `--name`, because a reviewer's reason cites area labels and the
 * naming pass is what gives an area its final label.
 */
export declare function attachOwners(root: string, report: BlastReport, opts?: OwnerOptions): void;
/** `9d ago`, `3mo ago` — how a comment says when someone was last in here. */
export declare function sinceLabel(last: number, now?: number): string;
/** `@handle`, or the bare name when git carries no handle for them. */
export declare function mention(o: Owner): string;
/** ISO day, for an exported page that has to stay truthful when opened later. */
export declare function isoDay(ms: number): string;
//# sourceMappingURL=owners.d.ts.map