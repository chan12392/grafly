/**
 * Project-dialect vocabulary — `.grafly/vocab.json`.
 *
 * A compact card of the tokens a codebase actually speaks: identifier
 * morphemes, module specifiers, called names, literal shapes, and repeated
 * 3-token idioms. One store, two provenances:
 *
 *   - `repo`: emitted by `buildGraph` from the same source bytes the wiring
 *     graph saw, so the card is rebuilt whenever the graph is.
 *   - `llm`: accumulated by `grafly vocab ingest <paths...>` over explicitly
 *     named LLM-written code (files or dirs, walked recursively).
 *
 * `grafly vocab` merges the two and tags every value `repo`, `llm`, or
 * `repo+llm` — the dialect the index learned vs. the dialect the assistant
 * writes, in one view.
 *
 * Extraction is language-agnostic regex (v0): comments and string contents are
 * masked (length-preserving, newlines kept) before the morpheme/callee/idiom
 * passes so prose doesn't read as dialect; specifier and literal passes scan
 * the raw source. Cheap enough to run over every file on every build.
 */
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./util/state.js";
/** Category keys — sibling implementations must emit exactly these. */
export const VOCAB_CATEGORIES = ["identifierMorphemes", "moduleSpecifiers", "calledNames", "literalShapes", "idioms"];
export const VOCAB_FILE = "vocab.json";
/** Exemplars kept per value; enough to show "where" without growing the store. */
const EXEMPLAR_CAP = 3;
/** Per-category row cap inside each stored source block. */
const TOP_DEFAULT = 50;
/** Wider cap for the `llm` source: brand-new identifiers an agent just wrote
 * sit at count 1 — the dialect's whole point — and a 50-row cap drops them. */
const LLM_TOP = 200;
/** Trigrams need at least this many occurrences in one file to count as an idiom. */
const IDIOM_MIN = 3;
const LITERAL_MAX = 40;
/** JS-ish reserved words dropped from morphemes and callee names — a constant
 * set regardless of `lang`, which v0 uses only to enable Python's bare-word
 * import syntax (its `import foo` would otherwise shadow the JS clause). */
const JS_KEYWORDS = new Set([
    "await", "async", "break", "case", "catch", "class", "const", "continue",
    "debugger", "default", "delete", "do", "else", "enum", "export", "extends",
    "finally", "for", "from", "function", "get", "if", "implements", "import",
    "in", "instanceof", "interface", "let", "new", "of", "package", "private",
    "protected", "public", "return", "set", "static", "super", "switch", "this",
    "throw", "try", "typeof", "var", "void", "while", "with", "yield",
]);
const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;
/** import/export ... from "x", import "x", require("x"), import("x") — the
 * quoted-specifier forms shared by JS/TS/Go-style grammars. Python's bare-word
 * `from x import y` / `import x.y` are added per-file when lang is python. */
const SPECIFIER_RE = [
    /\bfrom\s*['"]([^'"\n]+)['"]/g,
    /\bimport\s*['"]([^'"\n]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"\n]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"\n]+)['"]/g,
];
const PY_FROM_RE = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\s/gm;
const PY_IMPORT_RE = /^\s*import\s+([A-Za-z_][\w.]*)/gm;
/** Callee of `name(...)`. Declaration keywords before the name (function foo(,
 * def foo(, class Foo() are filtered with DECL_TAIL — they name a definition,
 * not a call. `new Foo(` stays: a constructor call IS dialect. */
const CALL_RE = /\b([A-Za-z_$][\w$]*)\s*\(/g;
const DECL_TAIL = /(?:function|def|fn|func|sub|proc|class|interface|enum|struct|trait|impl|typedef|macro)\s*$/;
const STRING_RE = /(["'`])((?:\\.|(?!\1)[^\\])*?)\1/g;
/** Strings before comments in the alternation: `"http://x"` must consume as a
 * string or its `//` opens a fake comment that eats the line. Python `#` joins
 * only for `lang==="python"` — elsewhere it would clobber `this.#x` lines. */
function mask(source, lang) {
    const re = new RegExp(`${STRING_RE.source}|//[^\\n]*|/\\*[\\s\\S]*?\\*/${lang === "python" ? "|#[^\\n]*" : ""}`, "g");
    return source.replace(re, (s) => s.replace(/[^\n]/g, " "));
}
const ENV_REF_RE = /\bprocess\.env\.([A-Za-z_$][\w$]*)/g;
const SCREAMING_SNAKE_RE = /^[A-Z0-9]+(_[A-Z0-9]+)+$/;
/** Offsets of every line start, for O(log n) match→line lookups. */
function lineIndex(source) {
    const starts = [0];
    for (let i = 0; i < source.length; i++)
        if (source.charCodeAt(i) === 10)
            starts.push(i + 1);
    return starts;
}
function lineOf(starts, index) {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= index)
            lo = mid;
        else
            hi = mid - 1;
    }
    return lo + 1;
}
/** ident → lowercase morphemes: snake/$ boundaries first, then camel/Pascal
 * splits (`fooBar` → foo bar, `HTMLParser` → html parser). Kept when len≥2,
 * has a letter, and isn't a keyword — so `e`, `x1`, `if` all drop out. */
function morphemes(ident) {
    const out = [];
    for (const part of ident.split(/[^A-Za-z0-9]+/)) {
        for (const piece of part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) {
            const v = piece.toLowerCase();
            if (v.length >= 2 && /[a-z]/.test(v) && !JS_KEYWORDS.has(v))
                out.push(v);
        }
    }
    return out;
}
/** Bucket a ≤40-char literal into its shape. Checked most-specific-first:
 * `://` before `/` or a URL is a path; `-` prefix last among the prefix rules
 * so `--out=./x` still reads as a path. Value stored as `shape:literal`. */
function shapeOf(lit) {
    if (SCREAMING_SNAKE_RE.test(lit))
        return "env";
    if (lit.includes("://"))
        return "url";
    if (lit.includes("/") || lit.includes("\\"))
        return "path";
    if (lit.startsWith("-"))
        return "flag";
    return "text";
}
/**
 * Extract one file's vocabulary: `{category: Map<value, {count, exemplars}>}`.
 * `rel` is the exemplar path (repo-relative for indexed files, whatever the
 * caller passes for ingested ones); `lang` currently only gates Python's
 * bare-word imports.
 */
export function extractVocab(rel, source, lang) {
    const out = {};
    for (const cat of VOCAB_CATEGORIES)
        out[cat] = new Map();
    const starts = lineIndex(source);
    const masked = mask(source, lang);
    const bump = (cat, value, index) => {
        const m = out[cat];
        let e = m.get(value);
        if (!e) {
            e = { count: 0, exemplars: [] };
            m.set(value, e);
        }
        e.count++;
        if (e.exemplars.length < EXEMPLAR_CAP)
            e.exemplars.push({ path: rel, line: lineOf(starts, index) });
    };
    for (const m of masked.matchAll(IDENT_RE))
        for (const morph of morphemes(m[0]))
            bump("identifierMorphemes", morph, m.index);
    const specRes = lang === "python" ? [...SPECIFIER_RE, PY_FROM_RE, PY_IMPORT_RE] : SPECIFIER_RE;
    for (const re of specRes)
        for (const m of source.matchAll(re))
            bump("moduleSpecifiers", m[1], m.index);
    for (const m of masked.matchAll(CALL_RE)) {
        const name = m[1];
        if (JS_KEYWORDS.has(name))
            continue;
        if (DECL_TAIL.test(masked.slice(Math.max(0, m.index - 40), m.index)))
            continue;
        bump("calledNames", name, m.index);
    }
    for (const m of source.matchAll(ENV_REF_RE))
        bump("literalShapes", `env:${m[1]}`, m.index);
    for (const m of source.matchAll(STRING_RE)) {
        const lit = m[2];
        if (lit.length < 2 || lit.length > LITERAL_MAX || !/[A-Za-z0-9]/.test(lit))
            continue;
        bump("literalShapes", `${shapeOf(lit)}:${lit}`, m.index);
    }
    // Idioms: every 3-token identifier/keyword window, kept when it repeats at
    // least IDIOM_MIN times in THIS file — recurrence in one source is what
    // makes it a habit rather than a coincidence.
    const tokens = [...masked.matchAll(IDENT_RE)];
    const trigrams = new Map();
    for (let i = 0; i + 2 < tokens.length; i++) {
        const key = `${tokens[i][0]} ${tokens[i + 1][0]} ${tokens[i + 2][0]}`;
        let rec = trigrams.get(key);
        if (!rec) {
            rec = { count: 0, idxs: [] };
            trigrams.set(key, rec);
        }
        rec.count++;
        if (rec.idxs.length < EXEMPLAR_CAP)
            rec.idxs.push(tokens[i].index);
    }
    for (const [key, rec] of trigrams) {
        if (rec.count < IDIOM_MIN)
            continue;
        out.idioms.set(key, { count: rec.count, exemplars: rec.idxs.map((i) => ({ path: rel, line: lineOf(starts, i) })) });
    }
    return out;
}
/** Fold a per-file extraction into an accumulator (mutates and returns `acc`). */
export function mergeVocab(acc, perFile) {
    for (const cat of VOCAB_CATEGORIES) {
        const src = perFile[cat];
        if (!src)
            continue;
        const dst = acc[cat] ?? (acc[cat] = new Map());
        for (const [value, e] of src) {
            const cur = dst.get(value);
            if (!cur) {
                dst.set(value, { count: e.count, exemplars: e.exemplars.slice(0, EXEMPLAR_CAP) });
                continue;
            }
            cur.count += e.count;
            for (const ex of e.exemplars) {
                if (cur.exemplars.length >= EXEMPLAR_CAP)
                    break;
                cur.exemplars.push(ex);
            }
        }
    }
    return acc;
}
function cmpVocab(a, b) {
    return b.count - a.count || a.value.localeCompare(b.value);
}
/** Accumulator → serializable `{category: [{value, count, exemplars}]}`,
 * count-desc then value-asc, capped at `top` rows per category. */
export function finalizeVocab(acc, top = TOP_DEFAULT) {
    const out = {};
    for (const cat of VOCAB_CATEGORIES) {
        out[cat] = [...(acc[cat]?.entries() ?? [])]
            .map(([value, e]) => ({ value, count: e.count, exemplars: e.exemplars }))
            .sort(cmpVocab)
            .slice(0, top);
    }
    return out;
}
/** Same merge at the finalized level — how the `llm` source accumulates across
 * ingest runs. Counts sum, exemplars concat to the cap, result re-sorted and
 * re-truncated. */
export function mergeFinalizedCategories(base, extra, top = TOP_DEFAULT) {
    const acc = {};
    for (const cat of VOCAB_CATEGORIES) {
        const m = new Map();
        for (const e of [...(base?.[cat] ?? []), ...(extra?.[cat] ?? [])]) {
            const cur = m.get(e.value) ?? { count: 0, exemplars: [] };
            cur.count += e.count;
            for (const ex of e.exemplars ?? [])
                if (cur.exemplars.length < EXEMPLAR_CAP)
                    cur.exemplars.push(ex);
            m.set(e.value, cur);
        }
        acc[cat] = m;
    }
    return finalizeVocab(acc, top);
}
export function vocabPath(outDir) {
    return join(outDir, VOCAB_FILE);
}
export function emptyVocabStore() {
    return { version: 1, sources: {} };
}
export function loadVocab(outDir) {
    const store = readJson(vocabPath(outDir));
    return store && typeof store === "object" && store.sources ? store : emptyVocabStore();
}
/** Known sources first (repo, llm) in fixed order; any future provenance a
 * sibling prototype wrote is preserved verbatim after them. */
function saveStore(outDir, store) {
    const ordered = {};
    for (const name of ["repo", "llm"])
        if (store.sources[name])
            ordered[name] = store.sources[name];
    for (const name of Object.keys(store.sources))
        if (!ordered[name])
            ordered[name] = store.sources[name];
    store.sources = ordered;
    writeJsonAtomic(vocabPath(outDir), store);
    return store;
}
/** Replace the `repo` source (a fresh build re-derives it wholesale) without
 * touching `llm`. */
export function saveRepoVocab(outDir, categories) {
    const store = loadVocab(outDir);
    store.sources.repo = { generatedAt: new Date().toISOString(), categories };
    return saveStore(outDir, store);
}
/** Accumulate into the `llm` source across `vocab ingest` runs, without
 * touching `repo`. */
export function addLlmVocab(outDir, categories) {
    const store = loadVocab(outDir);
    store.sources.llm = {
        updatedAt: new Date().toISOString(),
        categories: mergeFinalizedCategories(store.sources.llm?.categories, categories, LLM_TOP),
    };
    return saveStore(outDir, store);
}
/**
 * Merge a store's sources for display: `{category: [{value, count, provenance,
 * exemplars}]}` with provenance `repo` | `llm` | `repo+llm` (a value found in
 * both), sorted count-desc then value-asc, capped at `top` per category.
 */
export function mergedVocab(store, top = 20) {
    const card = {};
    for (const cat of VOCAB_CATEGORIES) {
        const m = new Map();
        for (const prov of ["repo", "llm"]) {
            for (const e of store.sources?.[prov]?.categories?.[cat] ?? []) {
                const cur = m.get(e.value) ?? { count: 0, prov: new Set(), exemplars: [] };
                cur.count += e.count;
                cur.prov.add(prov);
                for (const ex of e.exemplars ?? [])
                    if (cur.exemplars.length < EXEMPLAR_CAP)
                        cur.exemplars.push(ex);
                m.set(e.value, cur);
            }
        }
        card[cat] = [...m.entries()]
            .map(([value, e]) => ({
            value, count: e.count,
            provenance: e.prov.size === 2 ? "repo+llm" : [...e.prov][0],
            exemplars: e.exemplars,
        }))
            .sort(cmpVocab)
            .slice(0, top);
    }
    return card;
}
/**
 * Compact dialect block for INDEX.md — one line per category, `value×count`
 * items joined by `·`. Deterministic: no timestamps (INDEX.md itself carries
 * none). `*` marks a value seen only in the `llm` source.
 */
const INDEX_LABELS = {
    identifierMorphemes: "morphemes",
    moduleSpecifiers: "imports",
    calledNames: "calls",
    literalShapes: "literals",
    idioms: "idioms",
};
export function formatDialectLines(store, top = 8) {
    const card = mergedVocab(store, top);
    const lines = ["## Dialect", "",
        "How this repo's code talks — mined identifier and usage vocabulary",
        "(`grafly vocab` for the full card; `*` = llm-ingested only).", ""];
    for (const cat of VOCAB_CATEGORIES) {
        const rows = card[cat];
        if (!rows.length)
            continue;
        const items = rows.map((r) => `${r.value}×${r.count}${r.provenance === "llm" ? "*" : ""}`);
        lines.push(`${INDEX_LABELS[cat]}: ${items.join(" · ")}`);
    }
    lines.push("");
    return lines.length > 5 ? lines : [];
}
/** The `grafly vocab` card: one header line of source stamps, then per-category
 * `value×count [provenance]` rows. */
export function formatVocabCard(store, top = 20) {
    const card = mergedVocab(store, top);
    const stamps = [];
    if (store.sources?.repo?.generatedAt)
        stamps.push(`repo ${store.sources.repo.generatedAt}`);
    if (store.sources?.llm?.updatedAt)
        stamps.push(`llm ${store.sources.llm.updatedAt}`);
    const lines = [`dialect card${stamps.length ? ` — ${stamps.join(" · ")}` : ""}`];
    for (const cat of VOCAB_CATEGORIES) {
        const rows = card[cat];
        if (!rows.length)
            continue;
        lines.push(`${cat}:`);
        for (const r of rows)
            lines.push(`  ${r.value}×${r.count} [${r.provenance}]`);
    }
    return lines.join("\n") + "\n";
}
