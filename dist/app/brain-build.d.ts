import { type AppCredentials, type Fetch, type RepoAccessGap } from "./identity.js";
import { type RepoDigest } from "./history.js";
/** One request to build a repository into a brain. */
export interface BrainBuildJob {
    owner: string;
    repo: string;
    /** Branch to read; empty means the repository's default. */
    ref?: string;
    /**
     * The brain the rules land in, and the workspace key to write it with.
     *
     * Both optional, and omitting them changes the mode: with them, the digest is
     * posted straight to the brain and only a job id comes back; without them the
     * digest is RETURNED and the caller ingests it itself.
     *
     * The second mode is what the platform's own proxy uses. It already holds the
     * user's session and can write to the brain directly, so handing graft a
     * workspace key just to have it call back would mean minting a credential per
     * build for no gain.
     */
    brainId?: string;
    brainToken?: string;
    /** Platform base URL. Defaults to production. */
    brainBaseUrl?: string;
    /** File the rules as approved rather than as drafts. Onboarding sets it:
     * a brain whose every rule is an invisible draft answers nothing. */
    autoApprove?: boolean;
}
export interface BrainBuildResult {
    /** Set only when the digest was posted; empty in return-the-digest mode. */
    jobId: string;
    headSha: string;
    commits: number;
    threads: number;
    symbols: number;
    sources: number;
    /** Set only in return-the-digest mode. */
    digest?: RepoDigest;
}
export interface BrainBuildDeps {
    creds: AppCredentials;
    fetch: Fetch;
    api?: string;
    githubHost?: string;
    log?: (msg: string) => void;
    now?: () => number;
}
/** Raised when the App cannot see the repository. Distinct because the caller
 * turns it into a specific answer — "install the app, or run it locally" — and
 * not into a 500. */
export declare class RepoNotAccessibleError extends Error {
    /** Which gap it is, so the caller can send the user to the right place. */
    readonly gap: RepoAccessGap;
    constructor(message: string, 
    /** Which gap it is, so the caller can send the user to the right place. */
    gap?: RepoAccessGap);
}
/**
 * Read the repository and hand its history to the brain.
 *
 * Public repositories still go through the installation lookup, because the App
 * needs a token to clone at any useful rate limit, and a repository the App is
 * not installed on is exactly the case the UI has to distinguish.
 */
export declare function buildRepoIntoBrain(job: BrainBuildJob, deps: BrainBuildDeps): Promise<BrainBuildResult>;
//# sourceMappingURL=brain-build.d.ts.map