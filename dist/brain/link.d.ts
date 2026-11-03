/** How long a cached rule set is served before upkeep refreshes it. */
export declare const RULES_TTL_MS: number;
/** Serialize synchronous Brain mutations; do not await inside the callback. */
export declare function withBrainLock<T>(dir: string, update: () => T): T;
/**
 * The TTL used while the cache holds NO rules.
 *
 * A brain is connected during onboarding while it is still being mined, so the
 * first pull legitimately returns nothing. Six hours of that is the difference
 * between the feature working and the user concluding it does not: they wired
 * graft up, got an empty rulebook, and nothing would go back for the real one
 * until tomorrow. Two minutes costs one cheap request per session until the
 * rules land, and then the normal TTL takes over.
 */
export declare const EMPTY_RULES_TTL_MS: number;
/** One rule from the brain, anchored to a symbol in this repo. */
export interface BrainRule {
    ruleId: string;
    /** A graft node id: `<path>#<QualifiedName>`. */
    symbol: string;
    /** The symbol's body hash when the rule was mined; '' when unrecorded. */
    fingerprint: string;
    rule: string;
    /** Deep link to the commit or pull request that established it. */
    sourceUrl?: string;
}
/** The cached rule set, as stored under the repo's graft cache. */
export interface RulesCache {
    brainId: string;
    linkKey?: string | null;
    /** Only the latest started remote pull may replace this cache. */
    refreshId?: string;
    fetchedAt: number;
    rules: BrainRule[];
    /** When a refresh was last ATTEMPTED, successful or not. Separate from
     * `fetchedAt`, which records when rules last actually arrived: without the
     * distinction, a brain that is still building would be re-checked on every
     * single command, because its `fetchedAt` never advances. */
    checkedAt?: number;
}
/** The persisted brain link. */
export interface BrainLink {
    brainId: string;
    /** Locally recorded rules do not require a remote brain. */
    local?: boolean;
    /** Opt in to local background mining; cached rules remain usable when false. */
    background?: boolean;
    contextDir?: string;
    /** Workspace API key (`nn...`). Stored in the git-ignored `.graft/`. */
    token: string;
    /** Set only when the user pointed graft at a non-default host. */
    baseUrl?: string;
}
/**
 * The link for repo `dir`, or null when it has none.
 *
 * `GRAFT_BRAIN_TOKEN` / `GRAFT_BRAIN_ID` override the stored pair, so CI can
 * attach a brain without writing to the checkout.
 */
export declare function readLink(dir: string): BrainLink | null;
/** Persist the link for repo `dir`, merging into any existing build config. */
export declare function writeLink(dir: string, link: BrainLink): void;
/** Forget the link for repo `dir`. Leaves the cached rules for `uninstall` to remove. */
export declare function clearLink(dir: string): void;
/** Where the rule cache lives: beside the graph, since it is derived data. */
export declare function rulesCachePath(dir: string): string;
export declare function brainIdentity(link: BrainLink | null | undefined): string | null;
export declare function readRulesCache(dir: string, link?: BrainLink | null): RulesCache | null;
export declare function writeRulesCache(dir: string, cache: RulesCache, link?: BrainLink | null): void;
/**
 * Whether a cached set is old enough to refetch.
 *
 * Keyed off the last ATTEMPT, not the last success, and with a much shorter
 * window while the cache is empty — see EMPTY_RULES_TTL_MS for why that case
 * is the one that matters.
 */
export declare function cacheIsStale(cache: RulesCache | null, now?: number): boolean;
/** Record that a refresh was attempted, without claiming rules arrived. */
export declare function markRulesChecked(dir: string, now?: number): void;
/**
 * The base URL for a link, honouring the env override first so a misconfigured
 * stored value can always be corrected without editing a file.
 */
export declare function baseUrlFor(link: BrainLink): string;
/**
 * Fetch the brain's symbol-anchored rules.
 *
 * Returns null on any failure — an unreachable brain, a revoked token, a
 * malformed body. Never throws: `ask` degrades to the code-only answer it gave
 * before a brain was attached, which is the whole reason the cache exists.
 */
export declare function fetchRules(link: BrainLink, fetchImpl?: typeof fetch): Promise<BrainRule[] | null>;
