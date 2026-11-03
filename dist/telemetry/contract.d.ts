/**
 * The telemetry contract: the complete, machine-enforced list of what graft may
 * send. `TELEMETRY.md` is the same list in prose, and the two are kept in
 * lockstep — an event or property that is not in this file cannot be sent, and
 * one that is not in `TELEMETRY.md` must not be added here.
 *
 * Why an allowlist rather than a review rule: every telemetry incident in the
 * tools we studied came from a call site quietly adding a property nobody
 * audited. `track()` (track.ts) drops unknown events and unknown keys instead of
 * trusting its callers, so a future `track('query', { path })` sends `query`
 * with no `path` rather than leaking one. The blast radius of a careless call
 * site is "we lose a metric", never "we received someone's source tree".
 *
 * The other half of that guarantee is the value side: every number crosses as a
 * BUCKET and every string as a member of a fixed union. A raw file count plus a
 * language set starts to fingerprint a specific repo; `"100-500"` does not. A
 * raw error message is a path, a symbol, and sometimes a snippet of code; an
 * enum member is not.
 *
 * This module is pure — no I/O, no config, no clock. It is the file a reviewer
 * (or a suspicious user, since the repo is public) reads to verify the claim.
 */
/**
 * The contract itself. Common properties (see {@link COMMON_KEYS}) are stamped
 * centrally by `track()` and are deliberately not repeated per event.
 */
export declare const EVENTS: Record<string, ReadonlySet<string>>;
/** Stamped on every event by `track()`; not listed per event above. */
export declare const COMMON_KEYS: readonly ["app_version", "os", "arch", "node_major", "ci", "agent_host", "repo_id"];
/** Which surface issued a query. `hook` is Claude Code's prompt hook, which
 *  queries on the user's behalf without them typing a command. */
export type Surface = 'cli' | 'hook';
/** Which editor/agent graft is running under. Derived from the surface and the
 *  wiring on disk — never from a hostname, a username, or an env var's value. */
export type AgentHost = 'claude-code' | 'cursor' | 'cli';
/**
 * The commands worth counting. A command absent here is simply not reported —
 * `track()` drops the event rather than sending a free-form string, which is
 * what keeps a future `graft <something-user-named>` from becoming a data leak.
 */
export declare const TRACKED_COMMANDS: readonly ["ask", "grep", "callers", "skeleton", "map", "check", "blast"];
export type TrackedCommand = (typeof TRACKED_COMMANDS)[number];
export declare function isTrackedCommand(name: string): name is TrackedCommand;
/** Where a failing build died. Coarse on purpose: enough to route a bug, not
 *  enough to describe anyone's repo. */
export declare const BUILD_STAGES: readonly ["walk", "extract", "graph", "summarize", "synthesize", "write"];
export type BuildStage = (typeof BUILD_STAGES)[number];
/**
 * The failure taxonomy. Anything unrecognised becomes `E_UNKNOWN` — the point of
 * a closed set is that an unclassified error contributes a count and nothing
 * else, so no message text can ride along inside a "code".
 */
export declare const ERROR_CODES: readonly ["E_UNKNOWN", "E_PARSE", "E_TIMEOUT", "E_LLM", "E_AUTH", "E_RATE_LIMIT", "E_NETWORK", "E_DISK", "E_PERMISSION", "E_OOM", "E_LOCK"];
export type ErrorCode = (typeof ERROR_CODES)[number];
/**
 * Map a thrown value to a code without letting its text through. Only fixed
 * substrings are matched, and only a member of {@link ERROR_CODES} is returned —
 * the error's own message is never the return value, not even in part.
 */
export declare function errorCode(err: unknown): ErrorCode;
/** Repo scale. Exact counts fingerprint a repo; these five labels answer the
 *  only question we have ("toy, service, or monorepo?"). */
export declare function filesBucket(n: number): string;
/** Wall-clock for a build. Coarse enough that it says "fast/slow", not "this
 *  exact machine on this exact tree". */
export declare function durationBucket(ms: number): string;
/** Generic small-count bucket, for the per-session read counters. */
export declare function countBucket(n: number): string;
/** Estimated tokens saved in one session — the README's central claim, in the
 *  only resolution we need to defend it. */
export declare function savedTokensBucket(n: number): string;
/**
 * Languages, normalised, filtered to a safe shape, and capped.
 *
 * Sorted so `["go","ts"]` and `["ts","go"]` aggregate as one value, deduped, and
 * cut to eight — a repo with a very long tail of languages is itself a
 * distinguishing fact, and the tail answers no question we have.
 *
 * The character filter is the part that matters. This is the only property in
 * the contract that is not drawn from a closed set defined in this file: the
 * values come from the parser registry, several modules away, via
 * `languageLabelOf() ?? container.name ?? generic.name ?? "unknown"`. That is
 * safe today, but it means the no-free-text guarantee would rest on a promise
 * made elsewhere — and a future generic extractor naming itself after the
 * extension it matched would quietly turn this into a channel for file
 * metadata. Anything outside `[a-z0-9+#._-]`, or longer than 24 characters, is
 * therefore dropped here rather than trusted.
 */
export declare function langsValue(langs: readonly string[]): string;
