export interface AppCredentials {
    appId: string;
    /** PEM, as GitHub hands it over. */
    privateKey: string;
}
/**
 * A signed App JWT.
 *
 * `iat` is backdated a minute: GitHub compares against ITS clock, and a server
 * running even slightly fast has its tokens rejected as "issued in the future" —
 * a failure that looks like a bad key and is not.
 */
export declare function appJwt(creds: AppCredentials, nowMs: number): string;
export interface TokenResponse {
    token: string;
    expires_at: string;
}
/** Minimal shape of `fetch`, so tests need no network and no mocking library. */
export type Fetch = (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
}) => Promise<{
    ok: boolean;
    status: number;
    text: () => Promise<string>;
}>;
/**
 * Installation tokens, fetched once and reused until they are nearly expired.
 *
 * Tokens last an hour and a busy repository can fire a dozen webhooks a minute;
 * without the cache every one of them spends a round trip and a signature.
 */
/**
 * The installation id for one repository.
 *
 * Every existing caller gets the id from a webhook payload, because every
 * existing caller is reacting to one. A request that names a repository instead
 * has to look it up, and this is the only endpoint that answers it: it is
 * App-JWT authed, so it works before any installation token exists.
 *
 * Returns null when the App is not installed on the repository — which is the
 * expected answer for "the user pasted a repo we cannot see", not an error.
 */
export declare function installationFor(creds: AppCredentials, owner: string, repo: string, fetchImpl: Fetch, nowMs?: number, api?: string): Promise<number | null>;
/**
 * Why a repository is unreachable, and where to send the user to fix it.
 *
 * Two failures look identical from `/repos/{o}/{r}/installation` — both 404 —
 * and they need different sentences and different links. Either the App is not
 * on the account at all, so they install it; or it is installed and this
 * repository simply is not in its selected list, so they edit that list. Telling
 * someone to install an App they already installed is the kind of dead end that
 * ends the session.
 *
 * ownerId is the account's numeric id, which preselects the right account on
 * GitHub's install screen. There is no equivalent for preselecting a repository;
 * GitHub owns that checkbox list.
 */
export interface RepoAccessGap {
    reason: "not_installed" | "repo_not_selected";
    ownerId: number | null;
    installationId: number | null;
}
/** Which of the two gaps applies to owner/repo. */
export declare function repoAccessGap(creds: AppCredentials, owner: string, fetchImpl: Fetch, nowMs?: number, api?: string): Promise<RepoAccessGap>;
export declare class InstallationTokens {
    private readonly creds;
    private readonly fetchImpl;
    private readonly now;
    private readonly api;
    private readonly cache;
    constructor(creds: AppCredentials, fetchImpl: Fetch, now?: () => number, api?: string);
    get(installationId: number): Promise<string>;
    /** Drop a token GitHub has rejected, so the next call fetches a fresh one. */
    invalidate(installationId: number): void;
}
/**
 * Is this delivery really from GitHub?
 *
 * The webhook endpoint is public, and everything downstream — cloning a repo,
 * posting as the App — happens on its say-so. Compared in constant time because
 * a byte-at-a-time comparison leaks the expected digest to anyone willing to
 * measure, and forging a signature is a total compromise of the endpoint.
 */
export declare function verifySignature(secret: string, body: string, header: string | undefined): boolean;
//# sourceMappingURL=identity.d.ts.map