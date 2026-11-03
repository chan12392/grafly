import { type RepoDigest } from "../app/history.js";
import type { GraphV1 } from "../graph/types.js";
import { type BrainLink } from "./link.js";
/** What a local ingest read, for the caller to print. */
export interface PushResult {
    jobId: string;
    repo: string;
    commits: number;
    threads: number;
    symbols: number;
    sources: number;
    /** Set when discussion could not be read; the ingest still went ahead. */
    warning?: string;
}
/**
 * owner/name for this checkout, from its origin remote.
 *
 * Only GitHub, because the discussion reader and the forge links are
 * GitHub-shaped; another forge would need its own reader, not a looser regex
 * here that produces links to nowhere.
 */
export declare function repoSlugFromGit(root: string): {
    owner: string;
    name: string;
} | null;
/**
 * A GitHub token from wherever the user already keeps one.
 *
 * `gh auth token` first, because anyone who works with private repositories on
 * the command line has it and it needs no setup at all. The env vars are the
 * CI path. Absent, the ingest still runs on commits alone — pull-request
 * discussion is the richest source, not a required one.
 */
export declare function githubToken(): string | null;
/** What the brain is waiting for, when it is waiting for something. */
export interface ExpectedRepo {
    slug: string;
    status: string;
    brainName: string;
}
/**
 * The repository this brain expects, or null when it expects none.
 *
 * The website records it when the user chooses the local route, so this is how
 * the CLI knows whether the directory it is standing in is the one they asked
 * for. Mining the wrong repo into a brain is silent and very hard to notice
 * afterwards — the rules simply describe someone else's codebase — so the round
 * trip is worth it.
 *
 * Null on any failure, which keeps an older brain (or an unreachable one)
 * working exactly as it did before this check existed.
 */
export declare function fetchExpectedRepo(link: BrainLink, fetchImpl?: typeof fetch): Promise<ExpectedRepo | null>;
/** Whether two repo slugs name the same repository. GitHub is case-insensitive. */
export declare function sameRepo(a: string, b: string): boolean;
/** Build the digest for the checkout at `root`. Reads nothing but text. */
export declare function buildLocalDigest(root: string, graph: GraphV1 | null, opts?: {
    /** Explicit opt-in to GitHub discussion; the default reads only local files/history. */
    github?: boolean;
    autoApprove?: boolean;
    fetchImpl?: typeof fetch;
}): Promise<{
    digest: RepoDigest;
    warning?: string;
} | {
    error: string;
}>;
/** Send a digest to the brain and return the job to poll. */
export declare function pushDigest(link: BrainLink, digest: RepoDigest, fetchImpl?: typeof fetch): Promise<{
    jobId: string;
} | {
    error: string;
}>;
