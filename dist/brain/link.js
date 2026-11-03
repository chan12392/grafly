/**
 * The link between a repo's graft graph and a Trail brain.
 *
 * A brain holds the rules mined out of this repository's history — what the
 * team decided and why, which the code graph cannot see. Graft holds the code
 * and can say which symbols an answer touches. This module is the join: the
 * token identifying the brain, and the rules cached beside it so `ask` never
 * waits on the network.
 *
 * The link lives in the per-repo, git-ignored `.graft/config.json`, next to the
 * other persisted build choices. Not in `~/.graft/`: a brain belongs to one
 * repository, and two checkouts of different repos on one machine must not
 * share one.
 */
import { readBuildConfig, patchBuildConfig, cacheDir, readJson, writeJsonAtomic } from '../util/state.js';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { acquireProcessLock } from '../util/process-lock.js';

const heldLocks = new Set();
/** Serialize synchronous Brain mutations; network requests always run outside this lock. */
export function withBrainLock(dir, update) {
    const path = join(cacheDir(dir), 'brain.lock');
    if (heldLocks.has(path)) return update();
    const deadline = Date.now() + 5000;
    let release;
    while (!(release = acquireProcessLock(path))) {
        if (Date.now() >= deadline) throw new Error('Brain state is busy; retry the command.');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    heldLocks.add(path);
    try { return update(); }
    finally { heldLocks.delete(path); release(); }
}
/** How long a cached rule set is served before upkeep refreshes it. */
export const RULES_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
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
export const EMPTY_RULES_TTL_MS = 2 * 60 * 1000;
/**
 * The link for repo `dir`, or null when it has none.
 *
 * `GRAFT_BRAIN_TOKEN` / `GRAFT_BRAIN_ID` override the stored pair, so CI can
 * attach a brain without writing to the checkout.
 */
export function readLink(dir) {
    const stored = readBuildConfig(dir)?.brain;
    // A migrated local repo must not reconnect through old shell credentials.
    if (stored?.local) return stored;
    const envToken = process.env.GRAFLY_BRAIN_TOKEN ?? process.env.GRAFT_BRAIN_TOKEN;
    const envBrain = process.env.GRAFLY_BRAIN_ID ?? process.env.GRAFT_BRAIN_ID;
    const baseUrl = process.env.GRAFLY_BRAIN_URL || process.env.GRAFT_BRAIN_URL;
    if (envToken && envBrain) {
        return { brainId: envBrain, token: envToken, baseUrl };
    }
    if (!stored?.brainId || !stored?.token)
        return null;
    return baseUrl ? { ...stored, baseUrl } : stored;
}
/** Persist the link for repo `dir`, merging into any existing build config. */
export function writeLink(dir, link) {
    withBrainLock(dir, () => patchBuildConfig(dir, { brain: link }));
}
/** Forget the link for repo `dir`. Leaves the cached rules for `uninstall` to remove. */
export function clearLink(dir) {
    withBrainLock(dir, () => patchBuildConfig(dir, { brain: undefined }));
}
/** Where the rule cache lives: beside the graph, since it is derived data. */
export function rulesCachePath(dir) {
    return join(cacheDir(dir), 'brain-rules.json');
}
/** Cache identity for the effective connection; never persist a raw token. */
export function brainIdentity(link) {
    if (!link)
        return null;
    const base = link.local ? '' : (link.baseUrl || '').replace(/\/+$/, '');
    return createHash('sha256').update(JSON.stringify([link.brainId, !!link.local, base, link.token])).digest('hex');
}
export function readRulesCache(dir, link = readLink(dir)) {
    const cache = readJson(rulesCachePath(dir));
    if (!link || !cache || cache.brainId !== link.brainId || !Array.isArray(cache.rules))
        return null;
    // Legacy caches belong to the stored connection, never to an env override.
    const key = cache.linkKey || brainIdentity(readBuildConfig(dir)?.brain);
    if (key !== brainIdentity(link))
        return null;
    return cache;
}
export function writeRulesCache(dir, cache, link) {
    withBrainLock(dir, () => writeJsonAtomic(rulesCachePath(dir), { ...cache, linkKey: brainIdentity(link === undefined ? readLink(dir) : link) }, true));
}
/**
 * Whether a cached set is old enough to refetch.
 *
 * Keyed off the last ATTEMPT, not the last success, and with a much shorter
 * window while the cache is empty — see EMPTY_RULES_TTL_MS for why that case
 * is the one that matters.
 */
export function cacheIsStale(cache, now = Date.now()) {
    if (!cache)
        return true;
    const ttl = cache.rules.length === 0 ? EMPTY_RULES_TTL_MS : RULES_TTL_MS;
    return now - (cache.checkedAt ?? cache.fetchedAt) > ttl;
}
/** Record that a refresh was attempted, without claiming rules arrived. */
export function markRulesChecked(dir, now = Date.now()) {
    withBrainLock(dir, () => {
        const cache = readRulesCache(dir);
        if (cache) writeRulesCache(dir, { ...cache, checkedAt: now });
    });
}
/**
 * The base URL for a link, honouring the env override first so a misconfigured
 * stored value can always be corrected without editing a file.
 */
export function baseUrlFor(link) {
    const base = process.env.GRAFLY_BRAIN_URL || process.env.GRAFT_BRAIN_URL || link.baseUrl;
    if (!base) throw new Error('Set GRAFLY_BRAIN_URL to your Brain server before connecting.');
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Brain URL must use http or https.');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
        throw new Error('Remote Brain URLs must use HTTPS; HTTP is allowed only on loopback.');
    return base.replace(/\/+$/, '');
}
/** Timeout for one rules fetch. Short: `ask` must never block on this. */
const FETCH_TIMEOUT_MS = 5000;
/**
 * Fetch the brain's symbol-anchored rules.
 *
 * Returns null on any failure — an unreachable brain, a revoked token, a
 * malformed body. Never throws: `ask` degrades to the code-only answer it gave
 * before a brain was attached, which is the whole reason the cache exists.
 */
export async function fetchRules(link, fetchImpl = fetch) {
    // The PUBLIC, token-authenticated route: graft runs on a laptop with no
    // session, and the token it holds is scoped to this one brain rather than the
    // workspace. The protected route is for the app itself.
    try {
        const url = `${baseUrlFor(link)}/api/public/brains/${encodeURIComponent(link.brainId)}/rules/anchors`;
        const res = await fetchImpl(url, {
            headers: { authorization: `Bearer ${link.token}`, accept: 'application/json' },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok)
            return null;
        const body = (await res.json());
        if (!Array.isArray(body.anchors))
            return null;
        const out = [];
        for (const a of body.anchors) {
            // symbol may be "" — repo-wide rules carry no anchor; they still
            // reach the instruction-file section even though `ask` can't
            // attach them to a symbol.
            if (typeof a?.symbol !== 'string' || typeof a?.rule !== 'string' || !a.rule.trim())
                continue;
            out.push({
                ruleId: String(a.rule_id ?? ''),
                symbol: a.symbol,
                fingerprint: String(a.fingerprint ?? ''),
                rule: a.rule,
                sourceUrl: a.source_url || undefined,
            });
        }
        return out;
    }
    catch {
        return null;
    }
}
