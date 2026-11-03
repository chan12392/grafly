/**
 * The one command a user runs to attach a brain: parse the handoff value,
 * store the link, pull the rules, write them into the agent files.
 */
import { type BrainLink, type BrainRule } from './link.js';
import { type BrainWrite } from './wire.js';
/**
 * Parse the `--brain` value.
 *
 * The onboarding page hands over one string so there is one thing to copy. Two
 * accepted shapes:
 *
 *   `<brainId>:<token>`  — the normal case, both halves in one paste
 *   `<brainId>`          — with the token in `GRAFT_BRAIN_TOKEN`, for CI, where
 *                          a secret must not appear in a command line
 *
 * A bare token with no brain id is rejected rather than guessed: pointing the
 * wrong brain at a repo would write another team's rules into it.
 */
export declare function parseBrainArg(value: string): BrainLink | {
    error: string;
};
/** What connecting a brain did, for the caller to print. */
export interface ConnectResult {
    linked: boolean;
    ruleCount: number;
    writes: BrainWrite[];
    /** Set when the rules could not be fetched; the link is still stored. */
    warning?: string;
}
/**
 * Store the link, pull the rules once, and write them into the agent files.
 *
 * The link is stored even when the pull fails. That is deliberate: a token
 * typed correctly against a brain that is momentarily unreachable should not
 * have to be pasted again — `graft brain pull` retries, and `ask` degrades to
 * the code-only answer meanwhile.
 */
export declare function connectBrain(repo: string, link: BrainLink, opts?: {
    home: string;
    ids?: string[];
    fetchImpl?: typeof fetch;
}): Promise<ConnectResult>;
/**
 * Re-pull the rules for an already-linked repo and rewrite the agent files.
 * Returns null when the repo has no brain linked.
 */
export declare function pullBrain(repo: string, opts: {
    home: string;
    ids?: string[];
    fetchImpl?: typeof fetch;
}): Promise<ConnectResult | null>;
/** The linked brain and its cached rule set, for `graft brain status`. */
export declare function brainStatus(repo: string): {
    link: BrainLink | null;
    rules: BrainRule[];
    fetchedAt: number | null;
};
