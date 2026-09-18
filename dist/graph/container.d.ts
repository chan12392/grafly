/**
 * Container tier — files that are not a language but a wrapper around one.
 *
 * A Vue SFC is the motivating case: `.vue` is HTML-shaped, and everything worth
 * indexing lives inside its `<script>` block. Registering `tree-sitter-vue` as a
 * breadth-tier language (generic.ts) would not help — that grammar parses the
 * shell (`<template>` / `<script>` / `<style>`) and hands back the script body as
 * one opaque `raw_text` node, so the cards would come out empty.
 *
 * So the container grammar is used only to answer "where does the embedded
 * language start and end", and the block itself goes to the DEPTH-tier extractor
 * (extract.ts). A `.vue` file therefore gets the same quality of extraction as a
 * `.ts` file — bindings, imports, resolved calls — not the signature-only output
 * the breadth tier would give.
 *
 * **The span shift is the whole risk here.** `extractFile` numbers its spans from
 * the start of the string it was handed, so every node comes back pointing at a
 * line in the script, not in the `.vue`. A span that is off by even one line is
 * worse than not indexing the file at all: graft's promise is that its
 * `file:line` is exact, and a plausible-but-wrong line silently sends the reader
 * to the wrong place. `test/container-extract.test.ts` pins this against
 * fixtures whose true line numbers are known.
 */
import { type ExtractResult, type Language } from "./extract.js";
/** A container language: the wrapper grammar, the node that holds the embedded
 * source, and which depth-tier extractor to hand that source to. */
export interface ContainerLang {
    name: string;
    exts: string[];
    /** wasm basename in tree-sitter-wasms/out/tree-sitter-<wasm>.wasm */
    wasm: string;
    /** Wrapper node that represents one embedded block (e.g. Vue's script_element). */
    block: string;
    /** Child of `block` holding the raw embedded source (e.g. Vue's raw_text). */
    body: string;
    /** Depth-tier grammar for the embedded language. TypeScript is a superset of
     * JavaScript, so it parses both `<script>` and `<script lang="ts">`. */
    inner: Language;
}
/** The container registry. Svelte and Astro are the same shape and would be a
 * row each, but they are left out until someone has a repo to verify them
 * against — a wrong `body` node type would produce silently misplaced spans. */
export declare const CONTAINER_LANGS: readonly ContainerLang[];
/** The container language for a path, or null if none claims it. */
export declare function containerLangOf(path: string): ContainerLang | null;
/** Every file extension the container tier claims. */
export declare function containerExtensions(): string[];
/** Warm the container grammars this repo needs. Same contract as
 * `warmGenericGrammars`: await once before the synchronous parse loop, and an
 * unavailable grammar is skipped rather than fatal (its files then extract to a
 * file node only, exactly as they do today). */
export declare function warmContainerGrammars(langNames: Iterable<string>): Promise<void>;
/** True if a container grammar has been warmed (else extraction is file-only). */
export declare function isContainerWarm(langName: string): boolean;
/**
 * Extract one container file. Synchronous; needs the grammar pre-warmed.
 *
 * Never throws: a missing grammar, an unparseable SFC or a script block the
 * inner extractor chokes on all degrade to "fewer nodes", because a build must
 * not fail over one component.
 */
export declare function extractContainer(rel: string, source: string, lang: ContainerLang): ExtractResult;
//# sourceMappingURL=container.d.ts.map