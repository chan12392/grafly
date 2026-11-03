/**
 * The one command a user runs to attach a brain: parse the handoff value,
 * store the link, pull the rules, write them into the agent files.
 */
import { readLink, writeLink, fetchRules, writeRulesCache, readRulesCache, baseUrlFor, brainIdentity, withBrainLock } from './link.js';
import { writeBrainSections } from './wire.js';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
/**
 * Parse the `--brain` value.
 *
 * The onboarding page hands over one string so there is one thing to copy. Two
 * accepted shapes:
 *
 *   `<brainId>:<token>`  — the normal case, both halves in one paste
 *   `<brainId>`          — with the token in `GRAFT_BRAIN_TOKEN`, for CI, where
 *                          a secret must not appear in a command line
 *
 * A bare token with no brain id is rejected rather than guessed: pointing the
 * wrong brain at a repo would write another team's rules into it.
 */
export function parseBrainArg(value) {
    const raw = value.trim();
    if (!raw)
        return { error: 'empty --brain value' };
    const cut = raw.indexOf(':');
    if (cut > 0) {
        const brainId = raw.slice(0, cut).trim();
        const token = raw.slice(cut + 1).trim();
        if (!brainId || !token)
            return { error: 'expected --brain <brainId>:<token>' };
        return { brainId, token };
    }
    const envToken = process.env.GRAFLY_BRAIN_TOKEN ?? process.env.GRAFT_BRAIN_TOKEN;
    if (!envToken) {
        return {
            error: 'expected --brain <brainId>:<token>, or a bare brain id with the token in GRAFLY_BRAIN_TOKEN',
        };
    }
    return { brainId: raw, token: envToken };
}
/**
 * Store the link, pull the rules once, and write them into the agent files.
 *
 * The link is stored even when the pull fails. That is deliberate: a token
 * typed correctly against a brain that is momentarily unreachable should not
 * have to be pasted again — `grafly brain pull` retries. Only rules from the
 * same connection may keep serving while it is unavailable.
 */
export async function connectBrain(repo, link, opts = { home: '' }) {
    // Persist the env-pointed base URL into the stored link so GRAFLY_BRAIN_URL
    // is needed once, at connect time — not re-exported in every shell forever.
    const baseUrl = baseUrlFor(link); // validate before saving a link or sending a token
    const storedLink = { ...link, baseUrl };
    const writes = withBrainLock(repo, () => {
        const changed = brainIdentity(readLink(repo)) !== brainIdentity(storedLink);
        const cache = readRulesCache(repo, storedLink);
        writeLink(repo, storedLink);
        if (!changed && cache) return [];
        writeRulesCache(repo, { brainId: link.brainId, fetchedAt: 0, rules: [] }, storedLink);
        return writeBrainSections(repo, opts.home, [], basename(repo), opts.ids);
    });
    return fetchAndApply(repo, storedLink, opts, writes);
}

async function fetchAndApply(repo, link, opts, writes = []) {
    const refreshId = randomUUID();
    const started = withBrainLock(repo, () => {
        if (brainIdentity(readLink(repo)) !== brainIdentity(link)) return false;
        const cache = readRulesCache(repo, link) ?? { brainId: link.brainId, fetchedAt: 0, rules: [] };
        writeRulesCache(repo, { ...cache, refreshId }, link);
        return true;
    });
    if (!started) return { linked: true, ruleCount: 0, writes,
        warning: 'the Brain connection changed before the pull — this response was not applied' };
    const rules = await fetchRules(link, opts.fetchImpl ?? fetch);
    return withBrainLock(repo, () => {
        // Background upkeep can finish after an explicit connection change.
        // Its response must not overwrite the newly selected Brain's cache/files.
        if (brainIdentity(readLink(repo)) !== brainIdentity(link)) {
            return { linked: true, ruleCount: 0, writes,
                warning: 'the Brain connection changed during the pull — this response was not applied' };
        }
        const cache = readRulesCache(repo, link);
        if (cache?.refreshId !== refreshId) return { linked: true, ruleCount: 0, writes,
            warning: 'a newer Brain pull superseded this response — it was not applied' };
        if (rules === null) {
            return {
                linked: true,
                ruleCount: 0,
                writes,
                warning: 'could not reach the brain to pull its rules — the link is saved; run `grafly brain pull` to retry',
            };
        }
        // Notes remain local until a response actually contains their server copy.
        const seen = new Set(rules.map(r => r.rule.trim()));
        for (const note of cache.rules) {
            if (!(note.rule_id ?? note.ruleId ?? '').startsWith('note-') || seen.has(note.rule.trim())) continue;
            rules.push(note);
            seen.add(note.rule.trim());
        }
        writeRulesCache(repo, { brainId: link.brainId, fetchedAt: Date.now(), rules }, link);
        writes.push(...writeBrainSections(repo, opts.home, rules, basename(repo), opts.ids));
        return { linked: true, ruleCount: rules.length, writes };
    });
}
/**
 * Re-pull the rules for an already-linked repo and rewrite the agent files.
 * Returns null when the repo has no brain linked.
 */
export async function pullBrain(repo, opts) {
    const snapshot = withBrainLock(repo, () => {
        const link = readLink(repo);
        if (!link) return { result: null };
        if (!link.local) return { link };
        const rules = readRulesCache(repo)?.rules ?? [];
        const writes = writeBrainSections(repo, opts?.home ?? '', rules, basename(repo), opts?.ids);
        return { result: { linked: true, local: true, ruleCount: rules.length, writes } };
    });
    return snapshot.link ? fetchAndApply(repo, snapshot.link, opts ?? { home: '' }) : snapshot.result;
}
/** The linked brain and its cached rule set, for `grafly brain status`. */
export function brainStatus(repo) {
    const link = readLink(repo);
    const cache = readRulesCache(repo);
    return { link, rules: cache?.rules ?? [], fetchedAt: cache?.fetchedAt ?? null };
}
