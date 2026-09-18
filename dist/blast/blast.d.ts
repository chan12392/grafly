import type { GraphV1 } from "../graph/types.js";
import { type ModuleIndex } from "./modules.js";
import type { ChangedFile } from "./diff.js";
import type { Owner, Reviewer } from "./owners.js";
export interface BlastOptions {
    /** BFS depth over incoming edges; `Infinity` for the full closure. */
    depth: number;
    /** Concept/directory labels. Built from the context dir when omitted. */
    modules?: ModuleIndex;
}
/** A changed symbol the walk started from. */
export interface Seed {
    id: string;
    name: string;
    kind: string;
    path: string;
    span: string;
    /** True for a whole-file seed (an added file, or a change outside any symbol). */
    wholeFile: boolean;
}
/** One dependent symbol, and how the walk reached it. */
export interface Impacted {
    id: string;
    name: string;
    kind: string;
    path: string;
    span: string;
    relation: string;
    depth: number;
}
/**
 * Where a cluster's label came from — the rungs of the naming ladder.
 *
 * `concept` — a concept node from a `--deep` build claims every file in the cluster.
 * `named`   — `graft blast --name` asked a model to name this cluster (see name.ts).
 * `symbol`  — the deterministic backstop: the cluster's most significant symbol.
 *
 * A bare directory is never a label. The whole point of the picture is that a
 * reviewer reads what is affected, and `src/graph/` tells them nothing they could
 * not get from the diff — but it must never be replaced by a guess either, so the
 * backstop names a real symbol rather than inventing a feature name.
 */
export type LabelSource = "concept" | "named" | "symbol";
/** Dependents grouped for the diagram: the unit a reviewer actually thinks in. */
export interface ImpactedModule {
    label: string;
    labelSource: LabelSource;
    /** Stable identity for the cluster, independent of its label: the concept name
     * or the directory it was grouped by. Naming and its cache key hang off this. */
    key: string;
    files: string[];
    symbols: Impacted[];
    /** Changed files whose edges reached this module — the diagram's arrows. */
    from: string[];
    /** Who has worked on these files, best first. Filled in by `attachOwners`;
     * absent when the radius was taken outside a git repository. */
    owners?: Owner[];
}
/**
 * Whether the diff brought its tests along.
 *
 * `changed` — a test file that reaches this area was edited in this PR.
 * `stale`   — tests reach it and the diff left every one of them alone.
 * `none`    — nothing under `test/` reaches it at all.
 * `na`      — no function, method or class changed here, so there is nothing to
 *             ask the question of: a types-only file, or config and wiring.
 */
export type TestSignal = "changed" | "stale" | "none" | "na";
/** One area of the diff: the changed files a reviewer thinks of as one thing. */
export interface ChangedArea {
    label: string;
    labelSource: LabelSource;
    /** The directory the cluster was grouped by — see {@link ImpactedModule.key}. */
    key: string;
    /** Changed, indexed, non-test files grouped under this label. */
    files: string[];
    /** Changed symbols seeded from those files. */
    seeds: number;
    tests: TestSignal;
    /** Test files with an edge into this area, and those of them the diff changed. */
    testFiles: string[];
    changedTestFiles: string[];
    /** Test reach, over the area's exported functions/methods/classes only. */
    reached: number;
    behavioural: number;
    /** Names of the behavioural symbols no test reaches, for the collapsed detail. */
    unreached: string[];
    /** Changed symbol names, behaviour first — the backstop label and the naming
     * prompt both read from this. */
    seedNames: string[];
    /** Who has worked on these files, best first — see {@link ImpactedModule.owners}. */
    owners?: Owner[];
}
export interface BlastReport {
    basis: string;
    depth: number;
    changed: ChangedFile[];
    /** Changed paths the graph has no node for: unsupported language, or deleted. */
    unindexed: string[];
    /** Changed paths that were deleted, called out because their dependents are
     * unknowable from a graph built at the post-change commit. */
    deleted: string[];
    seeds: Seed[];
    impacted: Impacted[];
    modules: ImpactedModule[];
    /** The diff itself, grouped: the left-hand side of the diagram. */
    areas: ChangedArea[];
    /** Test-only dependents, kept out of `modules` so they cannot crowd it out. */
    testModules: ImpactedModule[];
    /** Who to tag, ranked across every area. Absent outside a git repository, and
     * empty when the author is the only person in the history. */
    reviewers?: Reviewer[];
}
/** Compute the blast radius of `changed` against `graph`. */
export declare function blastRadius(graph: GraphV1, changed: ChangedFile[], basis: string, opts: BlastOptions): BlastReport;
/** Convenience wrapper: build the module index from a context dir. */
export declare function blastRadiusIn(graph: GraphV1, contextDir: string, changed: ChangedFile[], basis: string, depth: number): BlastReport;
/**
 * The deterministic backstop label: the cluster's most significant symbol.
 *
 * Reached with no concept, no cache and no API key, so this is what guarantees a
 * circle never carries a bare directory. It is a fact rather than a guess — the
 * reviewer can grep the name — which is why it beats borrowing a neighbouring
 * concept: on graft's own graph that borrowing labelled the freshness gate
 * "Graph Extraction and Loading", which misleads worse than any path.
 */
export declare function hubLabel(names: string[], fallback: string): string;
//# sourceMappingURL=blast.d.ts.map