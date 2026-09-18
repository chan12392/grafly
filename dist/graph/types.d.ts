/**
 * `graph.json` — the code graph schema (v1).
 *
 * One node per definition (file, class, function, method, interface, type, enum),
 * wired by edges (contains, imports, calls, ...). Field names follow the LSP
 * vocabulary (`name`, `kind`, ...) rather than any one tool's conventions.
 *
 * Two tiers of data live on a node:
 *   - Tier-1 (deterministic, $0): everything from the AST. Rebuilt on every run.
 *   - Tier-2 (one LLM call, cached on `body_hash`): `summary` + `crux`.
 * M1 populates Tier-1 only; Tier-2 fields ship as `pending`/null.
 */
/** What a node represents. LSP SymbolKind, narrowed to what our extractors produce. */
export type Kind = "file" | "class" | "function" | "method" | "interface" | "type" | "enum" | "struct" | "trait" | "module" | "constant" | "variable";
/** How confident we are an edge is true, best-first. The hand-written AST
 * resolver assigns `extracted`/`inferred`; the opt-in LSP enrichment pass
 * (`graft build --lsp`) can promote an edge to compiler-grade `lsp_resolved`
 * (an exact server-confirmed target) or `lsp_dispatch` (an interface/virtual
 * candidate). Order matters: consumers that rank by provenance treat earlier
 * values as stronger. */
export type Confidence = "lsp_resolved" | "lsp_dispatch" | "extracted" | "inferred";
/** Whether the LLM meaning-layer has been computed for a node. */
export type SummaryState = "pending" | "ready" | "stale";
/** The LLM-chosen business-logic excerpt. `code` is the source of truth; `span`
 * is a best-effort pointer that may drift and is never used to re-slice. */
export interface Crux {
    code: string;
    span: string;
}
export interface NodeV1 {
    id: string;
    name: string;
    kind: Kind;
    owner?: string;
    path: string;
    span: string;
    signature: string | null;
    exported: boolean;
    origin: "ast" | "generic";
    body_hash: string;
    chars?: number;
    body_text?: string;
    arity?: number;
    variadic?: boolean;
    summary_state: SummaryState;
    summary: string | null;
    crux: Crux | null;
}
export type Relation = "contains" | "calls" | "imports" | "references" | "implements" | "extends";
export interface EdgeV1 {
    source: string;
    target: string;
    relation: Relation;
    confidence: Confidence;
}
/** A ranking scope: a sub-project discovered by project-marker files (`package.json`,
 * `go.mod`, ...). `prefix` is a posix path relative to the graph root ("" = root scope);
 * `label` is the same value without a trailing slash (also "" for root); `markers` lists
 * which marker file(s) were found in that directory. See `src/graph/scopes.ts`. */
export interface ScopeV1 {
    prefix: string;
    label: string;
    markers: string[];
}
export interface GraphV1 {
    meta: {
        version: 1;
        nodeCount: number;
        edgeCount: number;
        languages: string[];
        /** Ranking scopes: posix path prefixes relative to the graph root, "" = root scope.
         * Absent (old graphs) ≡ [{ prefix: "", label: "" }]. Sorted by prefix length desc. */
        scopes?: ScopeV1[];
    };
    nodes: NodeV1[];
    edges: EdgeV1[];
}
//# sourceMappingURL=types.d.ts.map