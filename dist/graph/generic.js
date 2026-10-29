/**
 * Generic "breadth" extractor tier — one language-agnostic extractor over any
 * tree-sitter grammar + its `tags.scm` (the standard tree-sitter tags convention). This is how
 * graft covers the long tail of languages for ~one registry row each, instead of
 * a hand-written extractor per language (the depth tier in extract.ts).
 *
 * Grammars are WASM (`tree-sitter-wasm` bundle) loaded via `web-tree-sitter`, so
 * a new language needs no native node-gyp build. Loading is async (WASM init), so
 * callers MUST `await warmGenericGrammars([...])` once before the synchronous
 * `extractGeneric()` is used in a build/check loop. If a grammar isn't warmed,
 * `extractGeneric` degrades to a file node only (never throws).
 *
 * What it emits (signature-only): a file node + one node per `@definition.<kind>`
 * capture, and bare-name `calls` raw edges from `@reference.call` attributed to
 * the innermost enclosing definition. resolve.ts then resolves those calls by
 * name for free (same-file → extracted, unique-global → inferred). Member-call
 * receiver typing (recvType) is NOT produced here — that needs a per-language
 * binding pass; the opt-in LSP tier fills that gap for popular languages.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { contentHash } from "../util/id.js";
const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// queries/ ships beside the compiled JS (copied by the build); fall back to src.
const QUERY_DIRS = [join(HERE, "queries"), join(HERE, "..", "..", "src", "graph", "queries")];
/** The breadth registry. Add a row + a queries/<name>.scm to support a language.
 * Extensions here must NOT collide with the depth tier's EXTENSIONS (extract.ts). */
export const GENERIC_LANGS = [
    { name: "rust", exts: [".rs"], wasm: "rust" },
    { name: "java", exts: [".java"], wasm: "java" },
    { name: "c", exts: [".c", ".h"], wasm: "c" },
    { name: "cpp", exts: [".cpp", ".cc", ".cxx", ".hpp", ".hh"], wasm: "cpp" },
    { name: "ruby", exts: [".rb"], wasm: "ruby" },
    { name: "c_sharp", exts: [".cs"], wasm: "c_sharp" },
    // These ship a tags.scm (calls + symbols); ocaml/zig have none and use the
    // node-kind walker fallback (symbols only) — still one row, zero query.
    { name: "scala", exts: [".scala", ".sc"], wasm: "scala" },
    { name: "elixir", exts: [".ex", ".exs"], wasm: "elixir" },
    { name: "solidity", exts: [".sol"], wasm: "solidity" },
    { name: "ocaml", exts: [".ml", ".mli"], wasm: "ocaml" },
    { name: "zig", exts: [".zig"], wasm: "zig" },
    { name: "dart", exts: [".dart"], wasm: "dart" }, // surfaced by PR #38 (@muneebshere)
    { name: "clojure", exts: [".clj", ".cljs", ".cljc", ".bb"], wasm: "clojure" },
    { name: "nix", exts: [".nix"], wasm: "nix" },
    { name: "lua", exts: [".lua"], wasm: "lua" },
    { name: "powershell", exts: [".ps1", ".psm1"], wasm: "powershell" },
    // No extensions: selected only when the corresponding native binding fails.
    ...["typescript", "tsx", "python", "go", "r", "kotlin", "swift", "php"]
        .map(name => ({ name, exts: [], wasm: name })),
];
export function fallbackLangOf(name) {
    return GENERIC_LANGS.find(lang => lang.name === name) ?? null;
}
const byExt = new Map();
for (const l of GENERIC_LANGS)
    for (const e of l.exts)
        byExt.set(e, l);
/** The generic language for a path, or null if no breadth grammar claims it. */
export function genericLangOf(path) {
    const lower = path.toLowerCase();
    for (const [ext, l] of byExt)
        if (lower.endsWith(ext))
            return l;
    return null;
}
/** Every file extension a breadth-tier (generic tree-sitter) grammar claims. */
export function genericExtensions() {
    return GENERIC_LANGS.flatMap((l) => l.exts);
}
// tags.scm @definition.<X>  →  graft Kind (types.ts). Unmapped → "function".
const KIND = {
    function: "function", method: "method", class: "class", interface: "interface",
    type: "type", struct: "struct", enum: "enum", module: "module",
    constant: "constant", variable: "variable", field: "variable",
    object: "class", property: "variable", // Scala object; Swift/Scala property
};
const loaded = new Map();
let tsMod = null;
let initPromise = null;
function requireWasm(wasm) {
    // Resolve the grammar wasm from the tree-sitter-wasm bundle (its package.json
    // `exports` maps the bare "<lang>/…" subpath to the actual "out/<lang>/…" file).
    try {
        const p = require.resolve(`tree-sitter-wasm/${wasm}/tree-sitter-${wasm}.wasm`);
        return readFileSync(p);
    }
    catch {
        return null;
    }
}
function loadQuery(name) {
    let bundled;
    try { bundled = require.resolve(`tree-sitter-wasm/${name}/tags.scm`); }
    catch { /* not every grammar ships tags */ }
    for (const path of [...QUERY_DIRS.map(dir => join(dir, `${name}.scm`)), bundled].filter(Boolean)) {
        try {
            let raw = readFileSync(path, "utf8");
            // TypeScript's tags add types to the JavaScript query rather than repeat functions.
            if (name === "typescript" || name === "tsx")
                raw = readFileSync(require.resolve("tree-sitter-wasm/javascript/tags.scm"), "utf8") + "\n" + raw;
            // Sanitize editor-specific query predicates the tree-sitter Query compiler rejects.
            return raw.replace(/\(#(?:strip!|set!|set-adjacent!|select-adjacent!|make-range!|offset!|gsub!)[^()]*\)/g, "");
        }
        catch {
            /* try next dir */
        }
    }
    return null;
}
/** Warm the WASM grammars for the given graft lang names. Idempotent; must be
 * awaited once before extractGeneric is used in a sync loop. Unknown/unavailable
 * grammars are silently skipped (their files then extract as file-only). */
export async function warmGenericGrammars(langNames) {
    const want = new Set(langNames);
    const need = [...want].filter((n) => !loaded.has(n) && GENERIC_LANGS.some((l) => l.name === n));
    if (need.length === 0)
        return;
    if (!tsMod) {
        tsMod = await import("web-tree-sitter");
        initPromise = initPromise ?? tsMod.Parser.init();
    }
    await initPromise;
    const { Language, Query } = tsMod;
    for (const name of need) {
        const row = GENERIC_LANGS.find((l) => l.name === name);
        const bytes = requireWasm(row.wasm);
        if (!bytes)
            continue;
        try {
            const language = await Language.load(bytes);
            const scm = loadQuery(name);
            let query = null;
            if (scm) {
                try {
                    query = new Query(language, scm);
                }
                catch {
                    query = null;
                }
            }
            const parser = new tsMod.Parser();
            parser.setLanguage(language);
            loaded.set(name, { language, query, parser });
        }
        catch {
            /* grammar failed to instantiate — skip; files extract as file-only */
        }
    }
}
/** Test seam: swap in (or, with null, remove) a grammar entry, returning the
 * previous one so the caller can restore it. The parse-failure path in
 * extractGeneric needs a grammar that throws deterministically; the real crash
 * that motivated it (tree-sitter-wasm PHP on heredocs, #139) is heap-state
 * dependent, so tests inject a fake here instead of depending on it. */
export function swapGrammarForTest(name, entry) {
    const prev = loaded.get(name) ?? null;
    if (entry)
        loaded.set(name, entry);
    else
        loaded.delete(name);
    return prev;
}
/** Load one grammar from the tree-sitter-wasms bundle, initialising
 * web-tree-sitter on first call. Null when the wasm is missing or won't
 * instantiate — never throws, so a caller degrades instead of failing the build.
 *
 * Shared with the container tier (container.ts), which needs a grammar to find
 * where an embedded language starts but none of the tags.scm machinery above.
 * Kept here so web-tree-sitter is initialised exactly once per process. */
export async function loadWasmLanguage(wasm) {
    if (!tsMod) {
        tsMod = await import("web-tree-sitter");
        initPromise = initPromise ?? tsMod.Parser.init();
    }
    await initPromise;
    const bytes = requireWasm(wasm);
    if (!bytes)
        return null;
    try {
        return await tsMod.Language.load(bytes);
    }
    catch {
        return null;
    }
}
const PARSE_CHUNK = 16384; // <32KB slices — same tree-sitter limit workaround as extract.ts
/** Caller owns the returned tree and must delete it after walking its nodes. */
export function parseWasm(language, source) {
    if (!tsMod)
        return null;
    const parser = new tsMod.Parser();
    try {
        parser.setLanguage(language);
        return parser.parse((i) => source.slice(i, i + PARSE_CHUNK));
    }
    finally {
        parser.delete();
    }
}
function fileNode(rel, source) {
    return {
        id: rel, name: rel.split("/").pop() ?? rel, kind: "file", path: rel,
        span: `L1-L${Math.max(1, source.split("\n").length)}`, signature: null,
        exported: true, origin: "generic", body_hash: contentHash(source),
        chars: Buffer.byteLength(source), summary_state: "pending", summary: null, crux: null,
    };
}
/** Extract a single generic-tier file. Synchronous; needs the grammar pre-warmed.
 * Uses the grammar's compiled tags.scm when present (symbols + call edges);
 * otherwise falls back to a node-kind tree walker (symbols only) so ANY warmed
 * grammar yields a graph even with no vendored query. */
export function extractGeneric(rel, source, langName) {
    const nodes = [fileNode(rel, source)];
    const rawEdges = [];
    const entry = loaded.get(langName);
    if (!entry || !tsMod)
        return { nodes, rawEdges };
    let tree;
    try {
        tree = entry.parser.parse((i) => source.slice(i, i + PARSE_CHUNK));
    }
    catch (err) {
        entry.parser.reset();
        // A grammar that throws (e.g. a WASM "memory access out of bounds" from an
        // external scanner) is not a per-file syntax problem: swallowing it here left
        // the file with only its file node and the build reporting success. Rethrow so
        // build.ts records it in `errors`, the CLI prints it, and the extract cache
        // remembers the failure instead of caching an empty result as clean.
        throw new Error(`${langName} grammar threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!tree)
        return { nodes, rawEdges };
    try {
        const minted = new Set([rel]);
        const lines = source.split("\n");
        const defs = [];
        // One definition per source span: a grammar's tags.scm can capture the same node
        // under two @definition kinds (Swift `func` is method AND function), and the
        // walker can revisit a nested match — both would emit near-duplicate nodes.
        const spanSeen = new Set();
        // Mint one definition node from a whole-definition tree node. Shared by both
        // the tags.scm path and the walker fallback so id/span/signature/body_text are
        // built identically.
        const mkDef = (name, kind, whole) => {
            if (spanSeen.has(whole.startIndex))
                return;
            spanSeen.add(whole.startIndex);
            const idBase = `${rel}#${name}`;
            let id = idBase, n = 2;
            while (minted.has(id))
                id = `${idBase}~${n++}`;
            minted.add(id);
            const startRow = whole.startPosition.row, endRow = whole.endPosition.row;
            const sigLine = (lines[startRow] ?? "").trim().replace(/\s*\{?\s*$/, "");
            nodes.push({
                id, name, kind, path: rel,
                span: `L${startRow + 1}-L${endRow + 1}`,
                signature: sigLine || null, exported: true, origin: "generic",
                body_hash: contentHash(source.slice(whole.startIndex, whole.endIndex)),
                body_text: source.slice(whole.startIndex, whole.endIndex).replace(/\s+/g, " ").trim(),
                summary_state: "pending", summary: null, crux: null,
            });
            defs.push({ id, startIndex: whole.startIndex, endIndex: whole.endIndex });
        };
        const bound = GENERIC_BINDINGS[langName]?.(tree.rootNode) ?? null;
        if (entry.query) {
            tagsExtract(entry.query, tree.rootNode, rel, mkDef, defs, rawEdges, langName, bound?.bindings);
        }
        else {
            walkExtract(tree.rootNode, mkDef); // no tags.scm → symbols only
        }
        // The preprocessor is invisible to tags.scm, but in C/C++ a local `#include "x.h"`
        // IS the dependency graph — capture it as a file→file import. Likewise a Rust
        // `use crate::…` is an in-crate module dependency.
        if (langName === "c" || langName === "cpp")
            extractIncludes(tree.rootNode, rel, rawEdges);
        else if (langName === "rust")
            extractUses(tree.rootNode, rel, rawEdges);
        else if (langName === "php")
            extractPhpUses(tree.rootNode, rel, rawEdges);
        for (const spec of bound?.specs ?? [])
            rawEdges.push({ source: rel, relation: "imports", specifier: spec, file: rel });
        return { nodes, rawEdges };
    }
    finally {
        tree.delete();
    }
}
/** Pre-order walk over every named node under `root`. */
function visitAll(root, fn) {
    const visit = (n) => {
        fn(n);
        for (let i = 0; i < (n.namedChildCount ?? 0); i++) {
            const c = n.namedChild?.(i);
            if (c)
                visit(c);
        }
    };
    visit(root);
}
/** PHP `use App\Models\User;` → a file→class-file `imports` raw edge, one per imported
 * name (a `{ … }` group expands to several). `use function`/`use const` are skipped —
 * those name a symbol, not a PSR-4 class file. resolve.ts settles the fully-qualified
 * name to the in-repo file by namespace suffix, and drops it when it can't. */
function extractPhpUses(root, rel, rawEdges) {
    visitAll(root, (n) => {
        if (n.type === "namespace_use_declaration") {
            for (const fqn of phpUseNames(n.text))
                rawEdges.push({ source: rel, relation: "imports", specifier: fqn, file: rel });
        }
    });
}
/** The fully-qualified class names a PHP `use` declaration imports. Handles a plain
 * `use A\B\C;`, a comma list `use A\B, C\D;`, a group `use A\B\{C, D};`, and `as` aliases;
 * returns [] for `use function`/`use const` (symbol imports, not class files). */
function phpUseNames(text) {
    let s = text.replace(/^\s*use\s+/, "").replace(/;\s*$/, "").trim();
    if (/^(function|const)\b/.test(s))
        return [];
    const brace = s.indexOf("{");
    if (brace >= 0) {
        const prefix = s.slice(0, brace).replace(/\\\s*$/, "");
        const inner = s.slice(brace + 1, s.lastIndexOf("}"));
        return inner.split(",").map((m) => m.trim().replace(/\s+as\s+\w+$/i, "").trim()).filter(Boolean)
            .map((m) => `${prefix}\\${m}`);
    }
    return s.split(",").map((c) => c.trim().replace(/\s+as\s+\w+$/i, "").trim()).filter(Boolean);
}
/** Rust `use crate::a::b::Item` → a file→module `imports` raw edge whose specifier is the
 * crate-relative module path (`a/b`). Only in-crate imports are captured; `std::`,
 * `super::`, `self::`, external crates, and globs are skipped — resolve.ts settles the
 * path against the file's crate root, and drops it when it can't. */
function extractUses(root, rel, rawEdges) {
    visitAll(root, (n) => {
        if (n.type === "use_declaration") {
            const spec = rustUseModule(n.text);
            if (spec !== null)
                rawEdges.push({ source: rel, relation: "imports", specifier: spec ? `crate/${spec}` : "crate", file: rel });
        }
    });
}
/** The crate-relative path a Rust `use crate::…` names (`::`→`/`), or null when it is not
 * an in-crate import. The FULL path is returned — including any trailing item segment —
 * because a single `crate::lexical` can be either a module OR a crate-root item; the
 * resolver settles that by finding the longest prefix that is a real module file. A
 * `{ … }` group has no single item, so its prefix (before `{`) is the path. */
function rustUseModule(text) {
    let s = text.replace(/^\s*use\s+/, "").replace(/;\s*$/, "").trim();
    const brace = s.indexOf("{");
    if (brace >= 0)
        s = s.slice(0, brace).replace(/::\s*$/, "");
    else
        s = s.replace(/\s+as\s+\w+$/, "");
    s = s.trim();
    if (s !== "crate" && !s.startsWith("crate::"))
        return null; // only in-crate absolute imports
    if (s.includes("*"))
        return null; // glob — no single module target
    return s.replace(/^crate::?/, "").replace(/\s+/g, "").replace(/::/g, "/"); // "" = crate root
}
/** C/C++ `#include "header.h"` → a file→file `imports` raw edge. Only LOCAL includes
 * (quoted) are captured; system includes (`<stdio.h>`) are skipped — high volume, and
 * there is no in-repo target to navigate to. resolve.ts settles the quoted path to an
 * in-repo header (relative to the including file, else a unique path-suffix match), and
 * keeps it as an external string when it cannot — never a guessed edge. */
function extractIncludes(root, rel, rawEdges) {
    visitAll(root, (n) => {
        if (n.type === "preproc_include") {
            const raw = n.childForFieldName?.("path")?.text ?? "";
            if (raw.startsWith('"')) {
                const spec = raw.replace(/^"|"$/g, "").trim();
                if (spec)
                    rawEdges.push({ source: rel, relation: "imports", specifier: spec, file: rel });
            }
        }
    });
}
/** Per-language import binding: local name → {name, specifier}. An entry WITH
 * `name` is a bare binding (`import {work as w}` → `w()` calls the exported
 * `work`); an entry WITHOUT one is a namespace binding (`import ... as m` →
 * `m.f()`). `specifier` uses the vocabulary resolve.ts already dispatches on:
 * relative path for solidity/dart, `crate/a/b/Item` for rust, dotted name for
 * scala, ns name for clojure, module name for elixir, require arg for lua.
 * Collectors also return `specs` — every seen specifier — which become
 * file→file `imports` edges for languages that had none. */
const GENERIC_BINDINGS = {
    rust: rustBindings, solidity: solidityBindings, dart: dartBindings,
    scala: scalaBindings, clojure: clojureBindings, elixir: elixirBindings,
    lua: luaBindings,
};
/** Per-language qualifier read on a captured call-name node: is the call
 * qualified (`m.f`, `a::b`, `ns/f`) or bare? Returns null for a bare call,
 * {unbound:true} for an unbindable qualification, {specifier} for a
 * self-contained qualified path (rust `crate::x::f`, clojure `full.ns/f`),
 * or {local, mids} to look up the qualifier in the bindings map (mids = extra
 * module-path segments between qualifier and callee — rust `a::b::f`). */
const GENERIC_QUALIFIER = {
    rust: rustQualifier, solidity: solidityQualifier, clojure: clojureQualifier,
    elixir: elixirQualifier, lua: luaQualifier,
};
const firstId = (n) => {
    if (!n)
        return null;
    if (n.type === "identifier")
        return n.text;
    for (let i = 0; i < (n.namedChildCount ?? 0); i++) {
        const hit = firstId(n.namedChild(i));
        if (hit)
            return hit;
    }
    return null;
};
/** Rust `use` declaration → bare/qualified bindings. Only `crate::` paths are
 * in-repo (mirroring extractUses); `self::`/`super::`/external crates bind
 * nothing resolvable. */
function rustBindings(root) {
    const bindings = new Map();
    const segsOf = (n) => {
        if (!n)
            return null;
        if (n.type === "scoped_identifier")
            return [...(segsOf(n.childForFieldName("path")) ?? []), n.childForFieldName("name")?.text];
        if (n.type === "identifier" || n.type === "crate" || n.type === "self" || n.type === "super")
            return [n.text];
        return null;
    };
    // Expand one use-tree into leaf items: {segs, alias?}.
    const items = (n, prefix, out) => {
        if (!n)
            return out;
        if (n.type === "use_as_clause") {
            const t = n.namedChild(0), alias = n.namedChild(n.namedChildCount - 1)?.text;
            for (const it of items(t, prefix, []))
                out.push({ ...it, alias });
            return out;
        }
        if (n.type === "scoped_use_list") {
            const p = [...prefix, ...(segsOf(n.childForFieldName("path")) ?? [])];
            const list = n.namedChildren.find((c) => c.type === "use_list");
            for (let i = 0; i < (list?.namedChildCount ?? 0); i++)
                items(list.namedChild(i), p, out);
            return out;
        }
        if (n.type === "use_list") {
            for (let i = 0; i < n.namedChildCount; i++)
                items(n.namedChild(i), prefix, out);
            return out;
        }
        if (n.type === "use_wildcard")
            return out; // glob — binds nothing nameable
        const segs = segsOf(n);
        if (segs)
            out.push({ segs: [...prefix, ...segs] });
        return out;
    };
    visitAll(root, (n) => {
        if (n.type !== "use_declaration")
            return;
        const arg = n.namedChildren.find((c) => c.type !== "visibility_modifier" && c.type !== "attribute_item");
        for (const it of items(arg, [], [])) {
            const segs = it.segs;
            if (segs[0] !== "crate" || segs.length < 2)
                continue;
            const name = segs[segs.length - 1];
            const local = it.alias ?? name;
            bindings.set(local, { name, specifier: `crate/${segs.slice(1).join("/")}` });
        }
    });
    return { bindings, specs: new Set() }; // extractUses already emits module imports
}
function rustQualifier(nameNode) {
    const p = nameNode.parent;
    if (p?.type !== "scoped_identifier" || p.childForFieldName("name")?.id !== nameNode.id)
        return null;
    const mids = [];
    let cur = p.childForFieldName("path");
    while (cur?.type === "scoped_identifier") {
        mids.unshift(cur.childForFieldName("name")?.text);
        cur = cur.childForFieldName("path");
    }
    const first = cur?.text;
    if (first === "crate")
        return { specifier: mids.length ? `crate/${mids.join("/")}` : "crate" };
    if (first === "self" || first === "super" || !first)
        return { unbound: true };
    return { local: first, mids };
}
/** Solidity `import {X as Y} from "p"` / `import * as M from "p"`. The grammar
 * flattens the named-import list to bare identifiers, so the brace section is
 * text-parsed (same convention as rustUseModule/phpUseNames above). */
function solidityBindings(root) {
    const bindings = new Map(), specs = new Set();
    visitAll(root, (n) => {
        if (n.type !== "import_directive")
            return;
        const text = n.text;
        const named = /\{([^}]*)\}\s*from\s*["']([^"']+)["']/.exec(text);
        if (named) {
            specs.add(named[2]);
            for (const part of named[1].split(",")) {
                const m = /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(part);
                if (m)
                    bindings.set(m[2] ?? m[1], { name: m[1], specifier: named[2] });
            }
            return;
        }
        const star = /\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*["']([^"']+)["']/.exec(text);
        if (star) {
            specs.add(star[2]);
            bindings.set(star[1], { specifier: star[2] }); // namespace
            return;
        }
        const bare = /import\s+["']([^"']+)["']/.exec(text);
        if (bare)
            specs.add(bare[1]);
    });
    return { bindings, specs };
}
function solidityQualifier(nameNode) {
    const p = nameNode.parent;
    if (p?.type !== "member_expression")
        return null;
    const obj = p.childForFieldName("object") ?? p.namedChild(0);
    return obj?.type === "identifier" ? { local: obj.text, mids: [] } : { unbound: true };
}
/** Dart `import 'u.dart' show A` binds bare `A`. `as p` prefixes are namespaces,
 * but dart.scm only captures bare calls — a prefix binding could never fire, so
 * only `show` combinators are collected. `hide` binds nothing. */
function dartBindings(root) {
    const bindings = new Map(), specs = new Set();
    visitAll(root, (n) => {
        if (n.type !== "library_import")
            return;
        for (let i = 0; i < n.namedChildCount; i++) {
            const spec_node = n.namedChild(i);
            if (spec_node.type !== "import_specification")
                continue;
            const uriLit = (function find(n2) {
                if (n2.type === "string_literal")
                    return n2.text;
                for (let j = 0; j < n2.namedChildCount; j++) {
                    const hit = find(n2.namedChild(j));
                    if (hit)
                        return hit;
                }
                return null;
            })(spec_node);
            if (!uriLit)
                continue;
            const uri = uriLit.replace(/^["']|["']$/g, "");
            if (uri.includes(":"))
                continue; // package:/dart: — never in-repo
            const spec = uri.startsWith(".") ? uri : `./${uri}`;
            specs.add(spec);
            for (let j = 0; j < spec_node.namedChildCount; j++) {
                const comb = spec_node.namedChild(j);
                if (comb.type !== "combinator" || !comb.text.startsWith("show"))
                    continue;
                for (let k = 0; k < comb.namedChildCount; k++) {
                    const id = comb.namedChild(k);
                    if (id.type === "identifier")
                        bindings.set(id.text, { name: id.text, specifier: spec });
                }
            }
        }
    });
    return { bindings, specs };
}
/** Scala `import a.b.{C => D, E}` / `import a.b.C`. The specifier keeps the
 * full dotted name including the item (`a.b.C`) — resolve.ts retries the
 * enclosing name, which covers `import a.b.Obj.member`. Wildcards bind
 * nothing nameable. */
function scalaBindings(root) {
    const bindings = new Map(), specs = new Set();
    visitAll(root, (n) => {
        if (n.type !== "import_declaration")
            return;
        const ids = [];
        let selectors = null;
        for (let i = 0; i < n.namedChildCount; i++) {
            const c = n.namedChild(i);
            if (c.type === "identifier")
                ids.push(c.text);
            else if (c.type === "namespace_selectors")
                selectors = c;
        }
        if (!selectors) {
            if (ids.length >= 2) {
                specs.add(ids.join("."));
                bindings.set(ids[ids.length - 1], { name: ids[ids.length - 1], specifier: ids.join(".") });
            }
            return;
        }
        const base = ids.join(".");
        for (let i = 0; i < selectors.namedChildCount; i++) {
            const sel = selectors.namedChild(i);
            if (sel.type === "arrow_renamed_identifier") {
                const pair = sel.namedChildren.filter((c) => c.type === "identifier");
                if (pair.length === 2 && pair[1].text !== "_")
                    bindings.set(pair[1].text, { name: pair[0].text, specifier: `${base}.${pair[0].text}` });
            }
            else if (sel.type === "identifier") {
                bindings.set(sel.text, { name: sel.text, specifier: `${base}.${sel.text}` });
            }
            // `_` wildcard / `=> _` — unnameable
        }
        if (base)
            specs.add(base);
    });
    return { bindings, specs };
}
/** Clojure `(:require [a.b :refer [f g] :as ab])` / `(require '[...])`. `:refer`
 * names bind bare; `:as` binds a namespace (`ab/f` qualifies via the captured
 * symbol's `sym_ns`); a fully qualified `a.b/f` carries its own ns. */
function clojureBindings(root) {
    const bindings = new Map(), specs = new Set();
    const childOfType = (n, t) => {
        for (let i = 0; i < (n?.namedChildCount ?? 0); i++) {
            const c = n.namedChild(i);
            if (c.type === t)
                return c;
        }
        return null;
    };
    const parseVec = (vec) => {
        const ns = childOfType(vec, "sym_lit")?.text;
        if (!ns)
            return;
        specs.add(ns);
        for (let i = 0; i < vec.namedChildCount; i++) {
            const c = vec.namedChild(i);
            if (c.type !== "kwd_lit")
                continue;
            const next = vec.namedChild(i + 1);
            if (c.text === ":refer" && next?.type === "vec_lit") {
                for (let j = 0; j < next.namedChildCount; j++) {
                    const s = next.namedChild(j);
                    if (s.type === "sym_lit")
                        bindings.set(s.text, { name: s.text, specifier: ns });
                }
            }
            else if (c.text === ":as" && next?.type === "sym_lit") {
                bindings.set(next.text, { specifier: ns }); // namespace
            }
            else if (c.text === ":rename" && next?.type === "map_lit") {
                const syms = next.namedChildren.filter((x) => x.type === "sym_lit");
                for (let j = 0; j + 1 < syms.length; j += 2)
                    bindings.set(syms[j + 1].text, { name: syms[j].text, specifier: ns });
            }
        }
    };
    visitAll(root, (n) => {
        if (n.type !== "list_lit")
            return;
        const head = childOfType(n, "sym_lit")?.text;
        if (head === "ns" || head === "in-ns")
            for (let i = 0; i < n.namedChildCount; i++) {
                const inner = n.namedChild(i);
                if (inner.type === "list_lit" && inner.namedChild(0)?.type === "kwd_lit" && inner.namedChild(0).text === ":require")
                    for (let j = 1; j < inner.namedChildCount; j++) {
                        if (inner.namedChild(j).type === "vec_lit")
                            parseVec(inner.namedChild(j));
                    }
            }
        else if (head === "require" || head === "use")
            visitAll(n, (v) => {
                if (v.type === "vec_lit")
                    parseVec(v);
            });
    });
    return { bindings, specs };
}
function clojureQualifier(nameNode) {
    const lit = nameNode.parent;
    if (lit?.type !== "sym_lit")
        return null;
    const ns = lit.namedChildren.find((c) => c.type === "sym_ns")?.text;
    if (!ns)
        return null; // bare (f)
    return ns.includes(".") ? { specifier: ns } : { local: ns, mids: [] };
}
/** Elixir `alias Foo.Bar` (and `, as: Q`) — qualified `Bar.f()` only. `import`
 * is deliberately not collected: it makes every public name bare, so stamping
 * its specifier would force resolution into one module and lose calls to names
 * living elsewhere. */
function elixirBindings(root) {
    const bindings = new Map(), specs = new Set();
    visitAll(root, (n) => {
        if (n.type !== "call" || n.namedChild(0)?.text !== "alias")
            return;
        const args = n.namedChildren.find((c) => c.type === "arguments");
        const mod = args?.namedChildren.find((c) => c.type === "alias")?.text;
        if (!mod || mod.includes("{"))
            return; // `alias A.{B,C}` group form — unsupported
        specs.add(mod);
        let local = mod.split(".").pop();
        const kw = args.namedChildren.find((c) => c.type === "keywords");
        const pair = kw?.namedChildren.find((c) => c.type === "pair" && c.text.startsWith("as:"));
        const asName = pair?.namedChildren.find((c) => c.type === "alias")?.text;
        if (asName)
            local = asName;
        bindings.set(local, { specifier: mod });
    });
    return { bindings, specs };
}
function elixirQualifier(nameNode) {
    const p = nameNode.parent;
    if (p?.type !== "dot" || p.childForFieldName("right")?.id !== nameNode.id)
        return null;
    const left = p.childForFieldName("left");
    const text = left?.type === "alias" || left?.type === "identifier" || left?.type === "dot" ? left.text : null;
    if (!text)
        return { unbound: true };
    return { local: text.split(".").pop(), mids: [] };
}
/** Lua `local m = require("a.b")` / `require "a/b"` — namespace binding only
 * (`m.f()`, `m:f()` qualify through the table). */
function luaBindings(root) {
    const bindings = new Map(), specs = new Set();
    visitAll(root, (n) => {
        if (n.type !== "assignment_statement")
            return;
        const vars = n.namedChildren.find((c) => c.type === "variable_list");
        const vals = n.namedChildren.find((c) => c.type === "expression_list");
        const call = vals?.namedChildren.find((c) => c.type === "function_call");
        if (call?.childForFieldName("name")?.text !== "require")
            return;
        const args = call.namedChildren.find((c) => c.type === "arguments" || c.type === "string");
        let spec = null;
        visitAll(args ?? call, (s) => {
            if (spec === null && (s.type === "string_content" || s.type === "string"))
                spec = s.text.replace(/^["']|["']$/g, "");
        });
        const local = firstId(vars?.namedChild(0));
        if (spec && local) {
            specs.add(spec);
            bindings.set(local, { specifier: spec });
        }
    });
    return { bindings, specs };
}
function luaQualifier(nameNode) {
    const p = nameNode.parent;
    const field = p?.type === "dot_index_expression" ? "field" : p?.type === "method_index_expression" ? "method" : null;
    if (!field || p.childForFieldName(field)?.id !== nameNode.id)
        return null;
    const table = p.childForFieldName("table");
    return table?.type === "identifier" ? { local: table.text, mids: [] } : { unbound: true };
}
/** Stamp a call/reference edge with its import binding: a bare name bound by a
 * named import is rewritten to the exported name and pinned to the module; a
 * qualified call pins the module and keeps the member name. resolve.ts resolves
 * inside that file only — turning repo-wide-ambiguous names into in-file hits. */
function stampImport(edge, nameNode, bindings, qualifierOf) {
    const q = qualifierOf?.(nameNode);
    if (q) {
        if (q.unbound)
            return;
        const spec = q.specifier ??
            (() => {
                const b = bindings?.get(q.local);
                return b ? b.specifier + (q.mids?.length ? `/${q.mids.join("/")}` : "") : null;
            })();
        if (spec)
            edge.specifier = spec;
        return;
    }
    const b = bindings?.get(edge.name);
    if (b?.name) {
        edge.name = b.name;
        edge.specifier = b.specifier;
    }
}
/** tags.scm path: @definition.<kind> → nodes, @reference.call/@reference.send →
 * bare-name call edges attributed to the innermost enclosing definition. */
function tagsExtract(query, root, rel, mkDef, defs, rawEdges, langName, bindings) {
    const q = query;
    const matches = q.matches(root);
    // Some grammars' tags.scm capture a definition's own NAME token as a
    // @reference.call too (Ruby tags `def foo`'s `foo` as both @name and a call),
    // producing bogus self-loops (foo→foo). Skip any call at a definition's name token.
    const defNameAt = new Set();
    const calls = [];
    const refs = [];
    for (const m of matches) {
        const cap = {};
        for (const c of m.captures)
            cap[c.name] = c.node;
        const defKey = Object.keys(cap).find((k) => k.startsWith("definition."));
        if (defKey && cap.name) {
            defNameAt.add(cap.name.startIndex);
            mkDef(cap.name.text, KIND[defKey.slice("definition.".length)] ?? "function", defScope(cap[defKey], langName));
        }
        if (("reference.call" in cap || "reference.send" in cap) && cap.name)
            calls.push({ name: cap.name.text, at: cap.name.startIndex, node: cap.name });
        // Structural references the grammar already marks: a supertype (extends), an
        // implemented interface, an object creation (`new Foo`), a module alias. Grammars
        // label these @reference.class/.interface/.implementation/.module — heterogeneous
        // syntactically but all "names this symbol without calling it". They become
        // `references` edges the same precision-first resolver settles to a type-like def
        // (same-file certain, unique cross-file inferred, ambiguous dropped), so a data
        // class that's only ever extended or instantiated stops being an orphan.
        if (("reference.class" in cap || "reference.interface" in cap ||
            "reference.implementation" in cap || "reference.module" in cap) && cap.name)
            refs.push({ name: cap.name.text, at: cap.name.startIndex, node: cap.name });
    }
    // innermost enclosing definition of a token at byte offset `at`
    const enclosing = (at) => defs
        .filter((d) => d.startIndex <= at && at < d.endIndex)
        .sort((a, b) => (a.endIndex - a.startIndex) - (b.endIndex - b.startIndex))[0];
    const qualifierOf = GENERIC_QUALIFIER[langName];
    for (const c of calls) {
        if (defNameAt.has(c.at))
            continue;
        const enc = enclosing(c.at);
        const edge = { source: enc ? enc.id : rel, relation: "calls", file: rel, name: c.name };
        stampImport(edge, c.node, bindings, qualifierOf);
        rawEdges.push(edge);
    }
    for (const r of refs) {
        if (defNameAt.has(r.at))
            continue;
        const enc = enclosing(r.at);
        if (!enc)
            continue; // a reference with no enclosing definition has no sound source
        const edge = { source: enc.id, relation: "references", file: rel, name: r.name };
        stampImport(edge, r.node, bindings, qualifierOf);
        rawEdges.push(edge);
    }
}
// Node-type → Kind for the walker fallback. A node is a definition when its type
// ends with a declaration-ish suffix AND names a construct — matched most-specific
// first (method before function). Covers the common tree-sitter grammar vocab
// without any per-language query.
const DEF_SUFFIX = /(declaration|definition|_item|_specifier|_decl|_def|_binding)$/;
function classifyKind(type) {
    const t = type.toLowerCase();
    if (!DEF_SUFFIX.test(t) && !/^(class|struct|enum|interface|trait|module|namespace)/.test(t))
        return null;
    if (/method|constructor/.test(t))
        return "method";
    if (/func|function|def\b|subroutine|procedure/.test(t))
        return "function";
    if (/class/.test(t))
        return "class";
    if (/struct|record/.test(t))
        return "struct";
    if (/interface|trait|protocol/.test(t))
        return "interface";
    if (/enum/.test(t))
        return "enum";
    if (/module|namespace|package|mod_/.test(t))
        return "module";
    if (/const/.test(t))
        return "constant";
    if (/typedef|type_alias|type_def|alias/.test(t))
        return "type";
    if (/type/.test(t))
        return "type";
    if (/(^|_)(val|var|let|field|property)/.test(t))
        return "variable";
    return null;
}
/** The declared name of a node: its `name` field, else the first identifier-ish
 * descendant within a couple of levels. */
function nodeName(node) {
    const byField = node.childForFieldName?.("name");
    if (byField?.text)
        return byField.text;
    const stack = [{ n: node, d: 0 }];
    while (stack.length) {
        const { n, d } = stack.shift();
        if (d > 0 && /identifier|name/.test(n.type) && n.text && !n.text.includes("\n"))
            return n.text;
        if (d < 3)
            for (let i = 0; i < (n.namedChildCount ?? 0); i++) {
                const c = n.namedChild?.(i);
                if (c)
                    stack.push({ n: c, d: d + 1 });
            }
    }
    return null;
}
/** Walker fallback: DFS every named node, emit a def for each classified one
 * (symbols only — no call resolution without a query). */
function walkExtract(root, mkDef) {
    const visit = (n) => {
        const kind = classifyKind(n.type);
        if (kind) {
            const name = nodeName(n);
            if (name)
                mkDef(name, kind, n);
        }
        for (let i = 0; i < (n.namedChildCount ?? 0); i++) {
            const c = n.namedChild?.(i);
            if (c)
                visit(c);
        }
    };
    visit(root);
}
// Some grammars' tags.scm put @definition.<X> on a narrow node (C tags the
// `function_declarator`, not the whole `function_definition` with its body), so
// the capture's span stops before the body and calls inside it can't be
// attributed to the function. Expand up to the outermost enclosing
// declaration/definition node so a def's span covers its body.
const DEF_CONTAINER = /(definition|declaration|specifier|_item)$/;
function nextNamedSibling(n) {
    const tagged = n;
    if ("nextNamedSibling" in tagged)
        return tagged.nextNamedSibling ?? null;
    const p = n.parent;
    if (!p?.namedChild)
        return null;
    const count = p.namedChildCount ?? 0;
    for (let i = 0; i < count - 1; i++) {
        const c = p.namedChild(i);
        if (c && c.startIndex === n.startIndex && c.endIndex === n.endIndex)
            return p.namedChild(i + 1);
    }
    return null;
}
function defScope(node, langName) {
    let n = node;
    while (n.parent && DEF_CONTAINER.test(n.parent.type))
        n = n.parent;
    // Dart's grammar leaves `function_signature` / `method_signature` as a sibling
    // of `function_body` (no wrapping function_definition). Expand so a def's span
    // covers its body and calls inside it attribute to the function, not the file
    // or enclosing class. Gated on Dart so other breadth-tier languages are untouched.
    if (langName === "dart") {
        const body = nextNamedSibling(n);
        if (body?.type === "function_body") {
            return {
                type: n.type,
                text: n.text,
                startIndex: n.startIndex,
                endIndex: body.endIndex,
                startPosition: n.startPosition,
                endPosition: body.endPosition,
                parent: n.parent,
            };
        }
    }
    return n;
}
