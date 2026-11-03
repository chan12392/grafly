export type OffReason = 'no-key' | 'do-not-track' | 'ci' | 'disabled';
/** The `DO_NOT_TRACK` convention: set and not `0`/empty means "off". */
export declare function doNotTrack(env?: NodeJS.ProcessEnv): boolean;
/**
 * Every variable {@link inCi} reads, named once.
 *
 * Exported because a test that needs telemetry actually ON has to clear all of
 * them, and clearing a hand-copied subset is how this list silently drifts: the
 * `cursor-session-end` test cleared `CI` alone, so it passed on a laptop and failed
 * on GitHub Actions — where `GITHUB_ACTIONS` is set — for every run until someone
 * read the log. One list, both callers.
 */
export declare const CI_ENV_VARS: readonly ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "CIRCLECI", "TEAMCITY_VERSION", "JENKINS_URL", "TF_BUILD", "BUILD_NUMBER"];
/**
 * CI detection. `CI` covers essentially every provider; the rest are the ones
 * that historically did not set it. Deliberately generous — a false positive
 * costs one uncounted user, a false negative pollutes the dataset.
 *
 * `CI` is the one read with a value test: `CI=false` is a real thing a user sets
 * to mean "not CI", while the provider-specific vars are presence-only — none of
 * them is ever deliberately set to a falsy string.
 */
export declare function inCi(env?: NodeJS.ProcessEnv): boolean;
/** Null when telemetry may run, otherwise the first gate that closed. */
export declare function offReason(home?: string, env?: NodeJS.ProcessEnv): OffReason | null;
export declare function telemetryOn(home?: string, env?: NodeJS.ProcessEnv): boolean;
/** One line for `graft telemetry status`, naming the gate that is closed so a
 *  user who thinks they disabled it can see which switch actually took. */
export declare function explainOff(reason: OffReason): string;
