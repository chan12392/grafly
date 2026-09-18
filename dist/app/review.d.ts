import type { ReviewJob } from "./events.js";
import type { Fetch } from "./identity.js";
/** Hidden marker: how the App finds the comment it owns, on every later push. */
export declare const MARKER = "<!-- graft-blast-radius -->";
export interface ReviewDeps {
    token: (installationId: number) => Promise<string>;
    fetch: Fetch;
    api?: string;
    /** Somewhere to put the viewer page; returns the URL to link. Optional: the
     * comment is useful on its own, and a page that fails to publish must not cost
     * the review. */
    publish?: (job: ReviewJob, html: string) => Promise<string | null>;
    log?: (msg: string) => void;
}
export interface ReviewResult {
    /** `null` when the diff had nothing indexed to say. */
    commentUrl: string | null;
    areas: number;
    affected: number;
    viewerUrl: string | null;
}
export declare function reviewPullRequest(job: ReviewJob, deps: ReviewDeps): Promise<ReviewResult>;
//# sourceMappingURL=review.d.ts.map