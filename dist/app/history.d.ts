import type { GraphV1 } from "../graph/types.js";
/** Minimal fetch shape the GitHub readers need. */
export type Fetch = (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
}) => Promise<{
    ok: boolean;
    status: number;
    text: () => Promise<string>;
}>;
import type { HistorySource } from "./sources.js";
/** One commit's rule-bearing content. */
export interface HistoryCommit {
    sha: string;
    subject: string;
    body: string;
    files: string[];
}
/** One pull request's discussion. */
export interface HistoryThread {
    number: number;
    title: string;
    body: string;
    mergeSha: string;
    comments: Array<{
        body: string;
        path?: string;
    }>;
}
/** One symbol, as the brain needs it to anchor a rule. */
export interface HistorySymbol {
    id: string;
    path: string;
    name: string;
    kind: string;
    signature: string;
    fingerprint: string;
}
/** The whole payload posted to the brain. */
export interface RepoDigest {
    provider: "github" | "local";
    owner: string;
    name: string;
    head_sha: string;
    default_branch: string;
    is_private: boolean;
    commits: Array<{
        sha: string;
        subject: string;
        body: string;
        files: string[];
        symbols: string[];
    }>;
    threads: Array<{
        number: number;
        title: string;
        body: string;
        merge_sha: string;
        comments: Array<{
            body: string;
            path?: string;
        }>;
    }>;
    symbols: HistorySymbol[];
    /** Everything in the repo that is already a rule, or nearly one: instruction
     * files, decision records, config, ownership, reverts, test names. One array
     * rather than a field per kind, so adding a source is adding an entry. */
    sources: HistorySource[];
    auto_approve: boolean;
}
/**
 * Commit subjects, bodies and touched files, oldest first.
 *
 * `--no-merges`: a merge commit's message is "Merge pull request #N from …",
 * which establishes nothing — the decision is in the commits it brings in, and
 * in the thread. `--reverse` so a later reversal reads as a reversal downstream;
 * the extraction prompt relies on that ordering.
 */
export declare function readCommits(root: string, max?: number): HistoryCommit[];
/**
 * Closed pull requests and their discussion, most-discussed first.
 *
 * Closed only: an open PR's discussion has not concluded, so mining a rule out
 * of it would record a proposal as a decision.
 *
 * Comment counts have to be discovered by fetching, not by reading the list.
 * GitHub's `GET /pulls` list response carries NO `comments` or
 * `review_comments` field — those exist only on the single-PR GET — so an
 * earlier version that pre-filtered on them read `undefined` for every pull
 * request, scored them all zero and skipped the lot. The failure was silent and
 * total: every repository came back with no discussion at all. So the comments
 * are fetched for the most recently updated closed pull requests, and the
 * ranking happens afterwards, on counts that are real.
 *
 * Bot comments are dropped. A CI bot posting a coverage table is the single
 * largest source of text in a busy repo's threads and it establishes nothing.
 */
export declare function readThreads(owner: string, repo: string, token: string, fetchImpl: Fetch, api?: string, max?: number): Promise<HistoryThread[]>;
/**
 * Exported symbols from the graph, with the body hash that makes an anchored
 * rule self-invalidating.
 *
 * Exported only, and biggest first: an internal helper is not what a team's
 * rules are about, and the budget is better spent on the surface a rule is
 * likely to govern.
 */
export declare function readSymbols(graph: GraphV1 | null, max?: number): HistorySymbol[];
/**
 * Assemble the digest.
 *
 * Each commit carries the symbol ids its files touched, so a rule mined from a
 * commit message can be anchored even when the message names no symbol — which
 * is most of the time.
 */
export declare function buildDigest(input: {
    owner: string;
    name: string;
    headSha: string;
    defaultBranch: string;
    isPrivate: boolean;
    commits: HistoryCommit[];
    threads: HistoryThread[];
    symbols: HistorySymbol[];
    sources: HistorySource[];
    autoApprove: boolean;
}): RepoDigest;
/**
 * Post the digest to a brain.
 *
 * Returns the job id so the caller can hand it back to whoever asked for the
 * build, which is what the onboarding screen polls.
 */
export declare function postDigest(baseUrl: string, brainId: string, brainToken: string, digest: RepoDigest, fetchImpl: Fetch): Promise<{
    jobId: string;
}>;
