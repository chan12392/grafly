/** Most rules to attach to one answer. */
export const MAX_ATTACHED_RULES = 6;
/** Resolve every anchored rule for status reporting, before answer display limits. */
export function anchoredRules(rules, graph) {
    if (!rules.length || !graph)
        return [];
    // node id → its current pointer and body hash. One pass, not once per rule.
    const byId = new Map();
    for (const n of graph.nodes) {
        byId.set(n.id, { pointer: `${n.path}:${n.span}`, hash: n.body_hash });
    }
    const out = [];
    for (const r of rules) {
        const node = byId.get(r.symbol);
        if (!node)
            continue;
        out.push({
            rule: r.rule,
            pointer: node.pointer,
            // No recorded fingerprint means the rule was mined before hashing existed
            // (or against a symbol graft could not hash). Unknown is not stale: a
            // false "the code moved" is worse than saying nothing about freshness.
            stale: r.fingerprint !== '' && r.fingerprint !== node.hash,
            sourceUrl: r.sourceUrl,
        });
    }
    return out;
}
/**
 * The rules governing the symbols in `pointers`, resolved against `graph`.
 *
 * Scoped to the answer, not the repo: attaching every rule a brain holds would
 * turn a token-saving pack into a token-spending one, and `ask` prints the
 * saving it claims. Capped for the same reason.
 */
export function rulesForPointers(pointers, rules, graph) {
    const wanted = new Set(pointers), seen = new Set(), out = [];
    for (const rule of anchoredRules(rules, graph)) {
        // The same rule can be mined against two symbols in one answer; show it once.
        if (!wanted.has(rule.pointer) || seen.has(rule.rule)) continue;
        seen.add(rule.rule);
        out.push(rule);
        if (out.length === MAX_ATTACHED_RULES) break;
    }
    return out;
}
/**
 * Render the rules block appended to an `ask` pack.
 *
 * Deliberately terse. This rides along on every answer, so it has to earn its
 * tokens: one line per rule, the pointer it governs, and a link only when there
 * is one. The `[graft]` prefix is avoided — `sumSavingsFooters` scans for
 * `[graft] tokens saved ≈` and nothing here should look like a savings line.
 */
export function formatRules(applied) {
    if (!applied.length)
        return [];
    const lines = ['', 'rules that govern these symbols'];
    for (const a of applied) {
        const flag = a.stale ? ' (STALE — the code changed since this was decided)' : '';
        lines.push(`- ${a.rule}${flag}`);
        lines.push(`  ${a.pointer}${a.sourceUrl ? ` · ${a.sourceUrl}` : ''}`);
    }
    return lines;
}
