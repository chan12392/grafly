import type { AgentHost } from './contract.js';
/** One queued event, exactly as it will be sent. */
export interface QueuedEvent {
    event: string;
    properties: Record<string, string>;
    /** ISO timestamp, so a batch flushed a day late still lands on the right day. */
    timestamp: string;
    /** The install id, used as PostHog's `distinct_id` at send time. */
    distinct_id: string;
}
export interface TrackContext {
    /** Repo root, when the call site has one — supplies `repo_id`. */
    repo?: string;
    /** Which surface is calling. Defaults to the CLI. */
    host?: AgentHost;
    /** Test seam: a scratch `$HOME`. Production callers never pass this. */
    home?: string;
    /** Test seam: an environment to gate against. Production callers never pass
     *  this — a real run must be gated on the real `DO_NOT_TRACK` and `CI`. */
    env?: NodeJS.ProcessEnv;
}
/**
 * Which agent graft is running under, from the surface plus one env probe.
 *
 * Only the PRESENCE of `CLAUDECODE` is read, never its value — the distinction
 * matters: a value could be anything a user's shell profile put there, presence
 * is a boolean. Anything unrecognised is `cli`, which is the honest answer.
 */
export declare function detectHost(explicit?: AgentHost, env?: NodeJS.ProcessEnv): AgentHost;
/**
 * Record one event, if the contract allows it and the gates are open.
 *
 * Returns the event that was queued, or null — the return value exists for
 * tests and for `graft telemetry debug`, not for control flow at call sites.
 */
export declare function track(event: string, props?: Record<string, string | undefined>, ctx?: TrackContext): QueuedEvent | null;
/**
 * The `first_run` event, fired the once. Separate from `track` because its
 * trigger is a comparison against persisted state rather than anything a call
 * site knows.
 *
 * Gated on `firstRunAt` and NOT on `installId().firstRun`, which is the whole
 * reason this field exists: the npm postinstall hook mints the install id before
 * any command runs, so "did this call mint the id" is false on the genuine first
 * command and would have silenced this event permanently.
 */
export declare function trackFirstRunIfNew(ctx?: TrackContext): void;
/**
 * The `install` event, fired from the npm postinstall hook.
 *
 * Once per machine per version: an upgrade is a real install and worth counting,
 * a second `npm install` of a version already recorded is not. Unique machines
 * are then distinct install ids, exactly as for every other event.
 *
 * Nothing here is an exception to the gates — a fork with no key, CI,
 * `DO_NOT_TRACK` and `graft telemetry disable` all still close it. It is only a
 * call site that happens to run outside a command.
 */
export declare function trackInstallIfNew(ctx?: TrackContext & {
    global?: boolean;
}): void;
