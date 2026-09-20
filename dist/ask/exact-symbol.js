/** Explicit code names are separate evidence from subword relevance. Keep the
 * build/query tokenizer unchanged so existing ask sidecars remain compatible.
 * Ordinary prose words only opt in when quoted, called, or the entire query. */
export function queryIdentifiers(query) {
    const names = new Set();
    const pattern = /(?<![A-Za-z0-9_$./\\-])[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*(?![A-Za-z0-9_$/\\-])/g;
    for (const match of query.matchAll(pattern)) {
        const name = match[0];
        const before = query[match.index - 1];
        const after = query.slice(match.index + name.length);
        const quoted = (before === '`' || before === '"' || before === "'") && after[0] === before;
        if (/[a-z0-9][A-Z]|[_$.]|^[A-Z][A-Z0-9]+$/.test(name) ||
            quoted || /^\s*\(/.test(after) || query.trim() === name)
            names.add(name);
    }
    return names;
}

export function matchesIdentifier(name, identifiers) {
    // An unqualified request may name a qualified definition's leaf. A qualified
    // request must match the qualification too: Cache.get must not prefer Other.get.
    return identifiers.has(name) || identifiers.has(name.split('.').at(-1));
}

/** Exact definitions lead; preserve existing order within each evidence class.
 * Scores retain their original meaning, including cross-repo RRF scores. */
export function prependExactHits(exact, ranked, limit) {
    if (exact.length === 0)
        return ranked.slice(0, limit);
    const seen = new Set();
    const hits = [];
    for (const hit of [...exact, ...ranked]) {
        const key = JSON.stringify([hit.kind, hit.pointer, hit.title]);
        if (!seen.has(key)) {
            seen.add(key);
            hits.push(hit);
        }
    }
    return hits.slice(0, limit);
}
