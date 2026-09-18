/**
 * Who the App is, to GitHub.
 *
 * A GitHub App authenticates twice over: it signs a short JWT with its private
 * key to prove it is the App, then trades that for an *installation* token scoped
 * to one repository owner. The installation token is what matters here — it is
 * the reason this exists at all. A workflow on a fork's pull request gets a
 * read-only token and cannot comment; an App's installation token belongs to the
 * base repository, so a fork PR is no different from any other.
 *
 * `node:crypto` signs the JWT, so there is no dependency to audit for something
 * that handles a private key.
 */
import { createHmac, createSign, timingSafeEqual } from "node:crypto";
/** GitHub rejects a JWT older than 60s or more than 10 minutes in the future. */
const JWT_TTL_S = 540; // 9 minutes, inside the limit with room for clock skew
/** Renew this long before expiry rather than racing it. */
const RENEW_MARGIN_MS = 60_000;
const b64url = (b) => Buffer.from(b).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
/**
 * A signed App JWT.
 *
 * `iat` is backdated a minute: GitHub compares against ITS clock, and a server
 * running even slightly fast has its tokens rejected as "issued in the future" —
 * a failure that looks like a bad key and is not.
 */
export function appJwt(creds, nowMs) {
    const iat = Math.floor(nowMs / 1000) - 60;
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = b64url(JSON.stringify({ iat, exp: iat + JWT_TTL_S, iss: creds.appId }));
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    return `${header}.${payload}.${b64url(signer.sign(creds.privateKey))}`;
}
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
export async function installationFor(creds, owner, repo, fetchImpl, nowMs = Date.now(), api = "https://api.github.com") {
    const res = await fetchImpl(`${api}/repos/${owner}/${repo}/installation`, {
        headers: {
            authorization: `Bearer ${appJwt(creds, nowMs)}`,
            accept: "application/vnd.github+json",
            "user-agent": "graft-app",
        },
    });
    if (res.status === 404)
        return null;
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`installation lookup for ${owner}/${repo} failed: ${res.status} ${body.slice(0, 200)}`);
    }
    const parsed = JSON.parse(await res.text());
    return typeof parsed.id === "number" ? parsed.id : null;
}
/** Which of the two gaps applies to owner/repo. */
export async function repoAccessGap(creds, owner, fetchImpl, nowMs = Date.now(), api = "https://api.github.com") {
    const headers = {
        authorization: `Bearer ${appJwt(creds, nowMs)}`,
        accept: "application/vnd.github+json",
        "user-agent": "graft-app",
    };
    // An account is an org or a user and the endpoints differ, so try the org one
    // and fall back rather than making the caller know which it is.
    for (const path of [`/orgs/${owner}/installation`, `/users/${owner}/installation`]) {
        try {
            const res = await fetchImpl(`${api}${path}`, { headers });
            if (!res.ok)
                continue;
            const parsed = JSON.parse(await res.text());
            return {
                reason: "repo_not_selected",
                ownerId: parsed.account?.id ?? null,
                installationId: parsed.id ?? null,
            };
        }
        catch {
            // Try the other shape; a network failure here only costs a less specific
            // message, never the whole answer.
        }
    }
    return { reason: "not_installed", ownerId: await ownerIdFor(owner, fetchImpl, api), installationId: null };
}
/** The account's numeric id, for preselecting it on the install screen. */
async function ownerIdFor(owner, fetchImpl, api) {
    try {
        // Unauthenticated: a public account's id is public, and this runs on a path
        // where the App has no installation token to use anyway.
        const res = await fetchImpl(`${api}/users/${owner}`, {
            headers: { accept: "application/vnd.github+json", "user-agent": "graft-app" },
        });
        if (!res.ok)
            return null;
        return JSON.parse(await res.text()).id ?? null;
    }
    catch {
        return null;
    }
}
export class InstallationTokens {
    creds;
    fetchImpl;
    now;
    api;
    cache = new Map();
    constructor(creds, fetchImpl, now = Date.now, api = "https://api.github.com") {
        this.creds = creds;
        this.fetchImpl = fetchImpl;
        this.now = now;
        this.api = api;
    }
    async get(installationId) {
        const hit = this.cache.get(installationId);
        if (hit && hit.expiresMs - RENEW_MARGIN_MS > this.now())
            return hit.token;
        const res = await this.fetchImpl(`${this.api}/app/installations/${installationId}/access_tokens`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${appJwt(this.creds, this.now())}`,
                accept: "application/vnd.github+json",
                "user-agent": "graft-app",
            },
        });
        const body = await res.text();
        if (!res.ok) {
            // The body carries GitHub's reason ("integration not found", a key that does
            // not match the app id); losing it turns every setup mistake into "401".
            throw new Error(`installation token for ${installationId} failed: ${res.status} ${body.slice(0, 200)}`);
        }
        const parsed = JSON.parse(body);
        this.cache.set(installationId, { token: parsed.token, expiresMs: Date.parse(parsed.expires_at) });
        return parsed.token;
    }
    /** Drop a token GitHub has rejected, so the next call fetches a fresh one. */
    invalidate(installationId) {
        this.cache.delete(installationId);
    }
}
/**
 * Is this delivery really from GitHub?
 *
 * The webhook endpoint is public, and everything downstream — cloning a repo,
 * posting as the App — happens on its say-so. Compared in constant time because
 * a byte-at-a-time comparison leaks the expected digest to anyone willing to
 * measure, and forging a signature is a total compromise of the endpoint.
 */
export function verifySignature(secret, body, header) {
    if (!header)
        return false;
    const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(header);
    return a.length === b.length && timingSafeEqual(a, b);
}
//# sourceMappingURL=identity.js.map