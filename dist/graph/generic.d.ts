import type { ExtractResult } from "./extract.js";
/** A breadth-tier language: graft name, file extensions, and the wasm basename
 * in tree-sitter-wasm/<wasm>/tree-sitter-<wasm>.wasm. One row per language. */
export interface GenericLang {
    name: string;
    exts: string[];
    wasm: string;
}
/** The breadth registry. Add a row + a queries/<name>.scm to support a language.
 * Extensions here must NOT collide with the depth tier's EXTENSIONS (extract.ts). */
export declare const GENERIC_LANGS: readonly GenericLang[];
/** The generic language for a path, or null if no breadth grammar claims it. */
export declare function genericLangOf(path: string): GenericLang | null;
/** Every file extension a breadth-tier (generic tree-sitter) grammar claims. */
export declare function genericExtensions(): string[];
export interface Loaded {
    language: unknown;
    query: unknown | null;
}
/** Warm the WASM grammars for the given graft lang names. Idempotent; must be
 * awaited once before extractGeneric is used in a sync loop. Unknown/unavailable
 * grammars are silently skipped (their files then extract as file-only). */
export declare function warmGenericGrammars(langNames: Iterable<string>): Promise<void>;
/** True if a grammar has been warmed for this lang (else extractGeneric is file-only). */
export declare function isWarm(langName: string): boolean;
/** Test seam: swap in (or, with null, remove) a grammar entry, returning the
 * previous one so the caller can restore it. The parse-failure path in
 * extractGeneric needs a grammar that throws deterministically; the real crash
 * that motivated it (tree-sitter-wasm PHP on heredocs, #139) is heap-state
 * dependent, so tests inject a fake here instead of depending on it. */
export declare function swapGrammarForTest(name: string, entry: Loaded | null): Loaded | null;
/** Load one grammar from the tree-sitter-wasms bundle, initialising
 * web-tree-sitter on first call. Null when the wasm is missing or won't
 * instantiate — never throws, so a caller degrades instead of failing the build.
 *
 * Shared with the container tier (container.ts), which needs a grammar to find
 * where an embedded language starts but none of the tags.scm machinery above.
 * Kept here so web-tree-sitter is initialised exactly once per process. */
export declare function loadWasmLanguage(wasm: string): Promise<unknown | null>;
/** Parse with an already-loaded grammar. Returns the root node, or null if the
 * grammar was never warmed or the parse blew up. Companion to
 * `loadWasmLanguage` for callers outside this module. */
export declare function parseWasm(language: unknown, source: string): TsNode | null;
/** Extract a single generic-tier file. Synchronous; needs the grammar pre-warmed.
 * Uses the grammar's compiled tags.scm when present (symbols + call edges);
 * otherwise falls back to a node-kind tree walker (symbols only) so ANY warmed
 * grammar yields a graph even with no vendored query. */
export declare function extractGeneric(rel: string, source: string, langName: string): ExtractResult;
/** Minimal structural view of a web-tree-sitter node — shared with container.ts. */
export interface TsNode {
    type: string;
    text: string;
    startIndex: number;
    endIndex: number;
    startPosition: {
        row: number;
        column: number;
    };
    endPosition: {
        row: number;
        column: number;
    };
    parent: TsNode | null;
    namedChildCount?: number;
    namedChild?(i: number): TsNode | null;
    childForFieldName?(field: string): TsNode | null;
}
//# sourceMappingURL=generic.d.ts.map