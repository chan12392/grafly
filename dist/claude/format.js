import { basename } from 'node:path';
// The injection gate reuses the federation floors rather than inventing its own:
// "did we hit a real name, or match broadly enough to trust anyway" is the same
// question in both places, and one set of calibrated numbers beats two.
import { HIGH_FLOOR, STRONG_FLOOR } from '../ask/fuse.js';
import { dollarsSaved, formatDollars } from '../context/price.js';
const C = {
    indigo: (s) => `\x1b[38;2;84;111;255m${s}\x1b[0m`,
    amber: (s) => `\x1b[38;2;224;165;68m${s}\x1b[0m`,
    muted: (s) => `\x1b[38;5;244m${s}\x1b[0m`,
    text: (s) => `\x1b[38;5;251m${s}\x1b[0m`,
};
const SEP = C.muted(' · ');
export function freshnessSegment(s) {
    if (s.syncing)
        return C.amber('syncing…');
    if (s.dirty && s.staleCount > 0)
        return C.amber(`⚠ ${s.staleCount} stale`);
    if (s.dirty)
        return C.amber('⚠ stale');
    return C.indigo('✓ synced');
}
export function renderStatusline(stats, session, ctx) {
    if (!stats) {
        return [C.muted('◤ grafly · not built · run ') + C.text('grafly build')];
    }
    const top = [C.muted('◤ ') + C.indigo('grafly'), C.text(`${stats.nodeCount} nodes / ${stats.edgeCount} edges`)];
    top.push(freshnessSegment(stats));
    const saved = session?.savedTokens ?? 0;
    if (saved > 0) {
        // Dollars only once a turn has actually been billed — see context/price.ts.
        // Until then (turn one, or a host with no transcript) the token count
        // stands alone rather than carrying a rate nobody measured.
        const usd = dollarsSaved(saved, session?.inputCostMicros, session?.inputTokensBilled);
        const money = usd === null ? '' : ` · ~${formatDollars(usd)}`;
        top.push(C.indigo(`~${saved.toLocaleString()} tok saved${money}`));
    }
    const bottom = [];
    if (typeof ctx.ctxPct === 'number')
        bottom.push(C.text(`ctx ${ctx.ctxPct}%`));
    if (stats.lastFile)
        bottom.push(C.muted('last: ') + C.text(basename(stats.lastFile)));
    const lines = [top.join(SEP)];
    if (bottom.length)
        lines.push(C.muted('▸ ') + bottom.join(SEP));
    return lines;
}
function nodeIdsInFile(w, filePath) {
    // Host edit tools hand back absolute paths; on Windows those arrive with
    // backslash separators, which never matched the graph's forward-slash
    // node paths and left the blast radius silently dead. Normalize first.
    const fp = filePath.replace(/\\/g, '/');
    const nodes = w.nodes ?? [];
    return new Set(nodes.filter((n) => n.path && (fp === n.path || fp.endsWith(`/${n.path}`)))
        .map((n) => n.id));
}
export function incomingEdges(w, filePath) {
    const ids = nodeIdsInFile(w, filePath);
    if (!ids.size)
        return [];
    return (w.edges ?? []).filter((e) => ids.has(e.target) && !ids.has(e.source));
}
export function formatBlastRadius(w, filePath, cap = 8) {
    const edges = incomingEdges(w, filePath);
    if (!edges.length)
        return null;
    const byId = new Map((w.nodes ?? []).map((n) => [n.id, n]));
    const items = edges.slice(0, cap).map((e) => {
        const n = byId.get(e.source);
        const label = n ? `${n.name} (${basename(n.path)})` : e.source;
        return ` • ${e.relation} ← ${label}`;
    });
    const more = edges.length > cap ? `\n • +${edges.length - cap} more` : '';
    return `[grafly] blast radius for ${basename(filePath)}, who depends on it:\n${items.join('\n')}${more}`;
}
function tokensOf(chars) { return Math.round(chars / 4); }
/** The retrieval pack body — pointers, snippets, and (in --source mode) the
 * actual code span for each hit, so the agent reads it here instead of opening
 * the file. Kept separate so the tokens-saved math can measure this exact text. */
function retrievalBody(hits) {
    const blocks = hits.map((h, i) => {
        const ptr = (h.pointer ?? '').split(',')[0].trim();
        const snip = (h.snippet ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
        let b = ` ${i + 1}. ${h.title}: ${ptr}`;
        if (snip)
            b += `\n    ${snip}`;
        if (h.code)
            b += `\n\`\`\`\n${h.code}\n\`\`\``;
        return b;
    });
    // Two pack shapes: with inlined code the pack is substitutive (read here, don't
    // re-open); without code it is pointers-only — locators the agent may follow,
    // pulling spans itself via `grafly ask --source` (push→pull: per-prompt injected
    // tokens are always fresh full-price input, so the pack stays tiny).
    const header = hits.some((h) => h.code)
        ? '[grafly] retrieved context, read these spans; do not re-open the files:'
        : '[grafly] starting points — pull code with `grafly ask "<task>" --source`, impact with `grafly callers <sym>`, all hits with `grafly grep "<literal>"`:';
    return `${header}\n${blocks.join('\n')}`;
}
/** Tokens saved (baseline − this pack), or 0 when no honest estimate applies. */
export function retrievalTokensSaved(ask, cap = 5) {
    const hits = (ask.hits ?? []).slice(0, cap);
    if (!hits.length || !ask.saved || ask.saved.baselineChars <= 0)
        return 0;
    const pack = tokensOf(retrievalBody(hits).length);
    const base = tokensOf(ask.saved.baselineChars);
    return base > pack ? base - pack : 0;
}
export function formatRetrieval(ask, cap = 5) {
    const hits = (ask.hits ?? []).slice(0, cap);
    if (!hits.length)
        return null;
    const body = retrievalBody(hits);
    const saved = retrievalTokensSaved(ask, cap);
    if (saved <= 0)
        return body;
    const base = tokensOf(ask.saved.baselineChars);
    const pct = Math.round((saved / base) * 100);
    return (`${body}\n[grafly] tokens saved ≈ ${saved.toLocaleString()} (${pct}%); this pack ≈ ` +
        `${tokensOf(body.length).toLocaleString()} tok vs reading the ${ask.saved.files} file(s) whole ≈ ` +
        `${base.toLocaleString()} tok (estimate).`);
}
/** How many recently-injected pointers the novelty gate remembers per session. */
const INJECTED_POINTERS_CAP = 40;
/** How many weak-match nudges one session may spend. A line that shows up every
 * turn stops being read; two is enough to land the habit without becoming
 * wallpaper. */
export const NUDGE_CAP = 2;
/** The line injected instead of a weak pack: names the command, says why, once.
 * Deliberately not an imperative about grafly in general — it's a fact about this
 * prompt's match quality plus the command that fixes it. */
export function weakMatchNudge(s, strong) {
    const spent = s.nudges ?? 0;
    if (spent >= NUDGE_CAP)
        return null;
    s.nudges = spent + 1;
    return (`[grafly] weak match (${strong.toFixed(2)}) — run ` +
        `\`grafly ask "<task>" --source\` before grepping.`);
}
/**
 * The per-prompt injection gate. Returns the text to inject, or null to stay
 * silent. Mutates `s` to remember what was shown (caller persists it).
 *
 * Gate 1 — **strength**. A pack earns its place only if the top hit either landed
 * on a real symbol NAME (`coverageStrong ≥ STRONG_FLOOR`) or matched the query
 * broadly enough to trust regardless (`coverage ≥ HIGH_FLOOR`). This is the same
 * two-clause rule `fuse.ts` already uses to decide whether a whole sub-repo joins
 * a cross-repo ranking — a cheaper decision than this one, previously held to a
 * stricter standard. Failing it emits {@link weakMatchNudge} rather than nothing:
 * silence leaves the agent with no signal at all, and a borderline pack is worse
 * than either, because it reads as orientation and suppresses the very retrieval
 * call it should have triggered. Structural results carry neither score — the
 * resolved intent is itself the relevance signal — so they always pass.
 *
 * Gate 2 — **novelty**. Hits whose pointer was already injected this session are
 * dropped; if none remain, the pack is skipped.
 */
export function relevantRetrieval(ask, s, cap = 3) {
    if (!(ask.hits ?? []).length)
        return null;
    const lexical = typeof ask.coverage === 'number' || typeof ask.coverageStrong === 'number';
    // A named definition is stronger evidence than its share of a long prose
    // query. Keep novelty filtering below: exact names never force reinjection.
    if (lexical && !ask.hits.some((hit) => hit.exactSymbol)) {
        const strong = ask.coverageStrong ?? 0;
        const broad = ask.coverage ?? 0;
        if (strong < STRONG_FLOOR && broad < HIGH_FLOOR)
            return weakMatchNudge(s, strong);
    }
    const seen = new Set(s.injectedPointers ?? []);
    const fresh = ask.hits.filter((h) => !seen.has(h.pointer));
    if (!fresh.length)
        return null;
    const txt = formatRetrieval({ ...ask, hits: fresh }, cap);
    if (!txt)
        return null;
    s.injectedPointers = [...(s.injectedPointers ?? []), ...fresh.slice(0, cap).map((h) => h.pointer)]
        .slice(-INJECTED_POINTERS_CAP);
    return txt;
}
/** Session-start orientation: one stable line, identical bytes every session.
 * The previous shape — a multi-line directive plus a ~1.5 KB INDEX.md repo-map
 * dump — cost fresh input tokens every session and churned the cache prefix
 * whenever the map changed. A fixed line keeps the same steering signal (the
 * commands, the pick-one discipline, the tally reminder) cache-identical;
 * `grafly map` stays the pull path for repo shape. The discretionary skill
 * carries the full guidance once loaded. */
const ORIENTATION_LINE = `[grafly] This repo is indexed — query the graph before grep/read; pick ONE tool, act, don't re-ask reworded: grafly ask "<task>" --source · grafly grep "<literal>" · grafly skeleton <file> · grafly callers <sym> [--depth N|all] · grafly map (monorepo: add --in <path>/). Outputs open with "[grafly] tokens saved ≈ N" — close replies with a one-line 🌱 tally; never pipe through head/tail.`;
export function formatOrientation(staleNote) {
    const banner = staleNote ? `${staleNote}\n\n` : "";
    return `${banner}${ORIENTATION_LINE}`;
}
export function renderSubagent(agentName, session) {
    const q = session?.perAgentQuery?.[agentName];
    const tail = q ? SEP + C.muted('grafly: ') + C.text(q) : '';
    return C.muted('◤ ') + C.indigo(agentName) + tail;
}
