/**
 * Notes — rules written by whoever (or whatever) is working in this repo,
 * with no brain server and no LLM key involved at all.
 *
 * A hosted brain mines rules out of history; a note just records one the
 * author already knows: "we decided X". The cache file does not care where a
 * rule came from — `ask` attaches note rules exactly like mined ones, and
 * `writeBrainSections` lands them in the same fenced block.
 *
 * Two consumption paths, both already wired:
 *   - no link at all   → a local brain is minted ({brainId:"local"}), notes
 *                        stay on this machine, nothing is ever fetched
 *   - a real link      → notes append to the cache AND are pushed to the
 *                        brain's /rules endpoint best-effort, so a refresh
 *                        that rewrites the cache does not silently lose them
 */
import { basename } from 'node:path';
import { readLink, writeLink, readRulesCache, writeRulesCache, baseUrlFor, brainIdentity, withBrainLock } from './link.js';
import { writeBrainSections } from './wire.js';

/** Attach a local-only brain when none exists; the existing link is kept. */
export function ensureLocalBrain(repo) {
    return withBrainLock(repo, () => {
        const link = readLink(repo);
        if (link)
            return { link, created: false };
        writeLink(repo, { brainId: "local", token: "local", local: true });
        return { link: readLink(repo), created: true };
    });
}

/**
 * Append rules to the local cache. `entries` are {rule, symbol?, sourceUrl?,
 * repoWide?}; a symbol is validated against the graph so its body hash becomes
 * the fingerprint — the note self-invalidates when the code moves, same as a
 * mined rule. repoWide rules carry symbol "" and are delivered through the
 * instruction-file section, not `ask` attach.
 */
export function addRules(repo, entries, graph) {
    return withBrainLock(repo, () => {
        const byId = new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
        const { link } = ensureLocalBrain(repo);
        const cache = readRulesCache(repo, link) ?? { brainId: link.brainId, fetchedAt: 0, rules: [] };
        const seen = new Set(cache.rules.map((r) => r.rule.trim()));
        const added = [];
        const rejected = [];
        for (const e of entries) {
            const rule = String(e?.rule ?? "").trim();
            if (!rule) {
                rejected.push({ rule: e?.rule ?? null, error: "empty rule" });
                continue;
            }
            if (seen.has(rule)) {
                rejected.push({ rule, error: "duplicate of an existing rule" });
                continue;
            }
            const symbol = e?.repoWide ? "" : String(e?.symbol ?? "").trim();
            let fingerprint = "";
            if (!e?.repoWide) {
                if (!symbol) {
                    rejected.push({ rule, error: "needs --symbol, or --repo-wide" });
                    continue;
                }
                const node = byId.get(symbol);
                if (!node) {
                    rejected.push({ rule, symbol, error: "no such symbol in the graph" });
                    continue;
                }
                fingerprint = node.body_hash ?? "";
            }
            seen.add(rule);
            added.push({
                rule_id: `note-${Date.now().toString(36)}-${added.length}`,
                symbol,
                fingerprint,
                rule,
                sourceUrl: e?.sourceUrl || e?.source_url || undefined,
            });
        }
        if (added.length) {
            cache.rules = cache.rules.concat(added);
            cache.fetchedAt = Date.now();
            writeRulesCache(repo, cache);
        }
        return { added, rejected, total: cache.rules.length };
    });
}

/**
 * Push freshly noted rules to the attached brain's /rules endpoint so a later
 * pull does not rewrite the cache without them. Best-effort: the cache copy
 * stands either way, until a pull receives the server's copy of each note.
 */
export async function pushNotes(repo, link, added, fetchImpl = fetch) {
    if (!link || link.local || !added.length)
        return { pushed: 0 };
    if (brainIdentity(readLink(repo)) !== brainIdentity(link))
        return { pushed: 0, warning: 'the Brain connection changed; these notes were not pushed' };
    try {
        const res = await fetchImpl(`${baseUrlFor(link)}/api/public/brains/${encodeURIComponent(link.brainId)}/rules`, {
            method: "POST",
            headers: { authorization: `Bearer ${link.token}`, "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ anchors: added.map(({ rule_id, status, ...a }) => a) }),
            signal: AbortSignal.timeout(5000),
        });
        return res.ok ? { pushed: added.length } : { pushed: 0, warning: `brain refused the notes: ${res.status}` };
    }
    catch (e) {
        return { pushed: 0, warning: `could not reach the brain: ${e instanceof Error ? e.message : e}` };
    }
}

/** Re-render the instruction-file sections after notes change the cache. */
export function rewriteBrainSections(repo, home, ids) {
    return withBrainLock(repo, () => {
        const rules = readRulesCache(repo)?.rules ?? [];
        return writeBrainSections(repo, home, rules, basename(repo), ids);
    });
}
