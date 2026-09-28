/**
 * Dead-end journal — remembers searches that verifiably found nothing, so a
 * repeat on an unchanged scope is answered from the journal instead of
 * re-reading every indexed file.
 *
 * Agents re-run the same failed lookups across sessions ("does applyPatch
 * exist?" → grep → no hits → same grep tomorrow). The repeat cannot differ
 * unless the searched files did, so a miss is journaled together with a cheap
 * stamp of the scope — `{files, maxMtimeMs}` over exactly the source-file set
 * the build enumerates (`graph/source-files.js`), which is the set `grepGraph`
 * can ever read. An identical stamp on re-check means same files, same
 * contents-by-mtime: the recorded "zero hits" still holds and the search is
 * skipped. Any new, edited, or deleted source file changes the stamp and the
 * real search runs again.
 *
 * Fail-open everywhere: a missing or corrupt journal, a walk error, or a
 * failed write all degrade to the normal search. The journal is a cache, not
 * a source of truth — a wrongly short-circuited "absent" is far costlier than
 * a redundant grep.
 */
import { join, resolve } from "node:path";
import { CACHE_DIR, contextDirFor } from "../context/node-file.js";
import { readFingerprint } from "../graph/fingerprint.js";
import { listSourceStats } from "../graph/source-files.js";
import { readJson, writeJsonAtomic } from "../util/state.js";
/** Entries kept; once exceeded, the oldest recorded miss is evicted. */
const JOURNAL_CAP = 50;
const JOURNAL_FILE = "deadends.json";
function journalPath(ctxDir) {
    return join(ctxDir, CACHE_DIR, JOURNAL_FILE);
}
/**
 * The journal under `<ctxDir>/.cache/deadends.json` — a bare array of miss
 * entries, `[]` on a missing or unparseable file. Entries missing the fields
 * this reader needs (`q`, `scope`) are dropped rather than trusted.
 */
export function loadDeadends(ctxDir) {
    const parsed = readJson(journalPath(ctxDir));
    if (!Array.isArray(parsed))
        return [];
    return parsed.filter((e) => e !== null && typeof e === "object" &&
        typeof e.q === "string" && typeof e.scope === "string");
}
/**
 * Persist the journal atomically (scratch + rename, same discipline as every
 * `.cache` sidecar). Best-effort: a failed write returns false, never throws.
 */
export function saveDeadends(ctxDir, journal) {
    try {
        writeJsonAtomic(journalPath(ctxDir), journal, true);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Canonical form of a search pattern for journal identity: lowercased,
 * trimmed, runs of whitespace collapsed, and paired surrounding
 * quotes/backticks stripped — `" applyPatch "` and `applypatch` are the same
 * question asked twice. Match flags are NOT folded in here: a case-sensitive
 * miss proves nothing about a case-insensitive repeat (the wider search can
 * find what the narrower one missed), so callers encode the match mode into
 * `scope` instead.
 */
export function normalizeQuery(q) {
    let s = String(q ?? "").toLowerCase().trim().replace(/\s+/g, " ");
    while (s.length > 1 && s[0] === s[s.length - 1] &&
        (s[0] === '"' || s[0] === "'" || s[0] === "`"))
        s = s.slice(1, -1).trim();
    return s;
}
/**
 * Append (or refresh) a miss entry `{q, scope, scopeFingerprint,
 * filesSearched, ts}` — `filesSearched` rides along so a dead-end answer can
 * print the same "in N indexed files" note a real empty result produces. An
 * existing entry with the same normalized query + scope is replaced, not
 * duplicated, and the journal is capped at {@link JOURNAL_CAP} entries with
 * the oldest evicted first.
 */
export function recordMiss(journal, { query, scope = "", scopeFingerprint = null, filesSearched = 0 }) {
    const entry = { q: normalizeQuery(query), scope, scopeFingerprint, filesSearched, ts: Date.now() };
    const prior = journal.findIndex((e) => e.q === entry.q && e.scope === scope);
    if (prior !== -1)
        journal.splice(prior, 1);
    journal.push(entry);
    while (journal.length > JOURNAL_CAP)
        journal.shift();
    return entry;
}
/**
 * The journaled miss for this query + scope when — and only when — the scope
 * fingerprint is unchanged since it was recorded: identical `{files,
 * maxMtimeMs}` means nothing the search could read has moved. Returns the
 * entry (so the caller can reuse its `filesSearched` in the report) or null.
 */
export function checkDeadend(journal, { query, scope = "" }, scopeFingerprint) {
    if (!Array.isArray(journal) || !scopeFingerprint)
        return null;
    const q = normalizeQuery(query);
    const hit = journal.find((e) => e.q === q && e.scope === scope);
    const recorded = hit?.scopeFingerprint;
    if (!recorded)
        return null;
    return recorded.files === scopeFingerprint.files &&
        recorded.maxMtimeMs === scopeFingerprint.maxMtimeMs ? hit : null;
}
/**
 * Stamp the searched scope: `{files, maxMtimeMs}` over the same enumeration a
 * build uses — `listSourceStats` walks with the repo's persisted include-dir
 * and submodule choices, keeps only supported-language sources, and excludes
 * the index dir; the fingerprint's recorded `--only-dir` whitelist (when one
 * exists) narrows it to what was actually indexed. A new source file grows
 * `files`, an edit moves `maxMtimeMs`, a delete does both — any of them
 * forces the real search to run again.
 *
 * `ignorePredicate(rel)` narrows the stamp to a sub-scope (`--in`): it is
 * called with each repo-relative posix path, and files it rejects are not
 * stamped. `outDir` defaults to the repo's context dir; pass it when the
 * caller resolved a `--dir` override so the index keeps being excluded.
 * Errors propagate — the caller's fail-open guard decides.
 */
export function statScope(dir, ignorePredicate, outDir) {
    const root = resolve(dir);
    const ctx = outDir ?? contextDirFor(root);
    const recorded = readFingerprint(ctx)?.onlyDirs;
    const onlyDirs = recorded && recorded.length > 0 ? new Set(recorded) : undefined;
    let files = 0;
    let maxMtimeMs = 0;
    for (const f of listSourceStats(root, ctx, undefined, onlyDirs)) {
        if (ignorePredicate && ignorePredicate(f.rel))
            continue;
        files++;
        if (f.mtimeMs > maxMtimeMs)
            maxMtimeMs = f.mtimeMs;
    }
    return { files, maxMtimeMs };
}
//# sourceMappingURL=deadends.js.map
