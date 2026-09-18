/**
 * The HTTP surface: one webhook in, one page out.
 *
 * Deliberately `node:http` and nothing else. This process handles a private key,
 * a webhook secret and other people's source code, so every dependency is one
 * more thing to trust; the whole server is a hundred lines and needs no
 * framework.
 *
 * GitHub retries a delivery it considers failed and gives up after ten seconds,
 * while a review takes tens of them — so the handler validates, queues, and
 * answers 202. Everything real happens on the queue.
 *
 * "On the queue" used to mean "on this event loop", and that was the whole of a
 * multi-minute outage: a review is synchronous end to end, so one in flight left
 * this server unable to answer /healthz or serve a page it had already produced.
 * The queue now runs each review in its own process (`./review-process.ts`) and
 * everything in here is I/O again.
 */
import { type Server } from "node:http";
import { type ReviewJob } from "./events.js";
import { type AppCredentials, type Fetch } from "./identity.js";
import { buildRepoIntoBrain } from "./brain-build.js";
import { PageStore } from "./pages.js";
import { WorkQueue } from "./queue.js";
import type { reviewPullRequest } from "./review.js";
/** Seams for tests: nothing here has a default that touches the network. */
export interface AppSeams {
    fetch?: Fetch;
    /** Swapped out so a test can assert what the route handed the builder without
     * cloning a repository or reaching GitHub. */
    brainBuild?: typeof buildRepoIntoBrain;
    /** Swapped out to assert what the queue was handed, without a clone — and, being
     * called in-process, without the fork the default reviewer does. */
    review?: typeof reviewPullRequest;
    now?: () => number;
}
export interface AppConfig extends AppCredentials {
    webhookSecret: string;
    /** Shared secret for `POST /brain/build`. That route is called by the
     * platform, not by GitHub, so it cannot use the webhook's payload signature —
     * it takes a bearer token instead. Unset disables the route entirely, which
     * is the right default for a deployment that only reviews pull requests. */
    brainBuildSecret?: string;
    /** Platform base URL the digest is posted to. Defaults to production. */
    brainBaseUrl?: string;
    /** Public origin, for the links put in comments, e.g. https://graft.example.com */
    publicUrl: string;
    /** Where pages are kept, so a restart does not strand the links already posted. */
    pageDir?: string;
    port?: number;
    concurrency?: number;
    api?: string;
    log?: (msg: string) => void;
}
export declare function createApp(config: AppConfig, seams?: AppSeams): {
    server: Server;
    queue: WorkQueue<ReviewJob>;
    pages: PageStore;
};
//# sourceMappingURL=server.d.ts.map