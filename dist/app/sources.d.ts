import type { Fetch } from "./identity.js";
/** What kind of thing a source is, so extraction can weigh it. */
export type SourceKind = "agent_instructions" | "decision_doc" | "lint_config" | "ci_config" | "codeowners" | "branch_protection" | "revert" | "test_name" | "declined_issue";
/** One rule-bearing artefact. */
export interface HistorySource {
    kind: SourceKind;
    /** Repo-relative path, or an API-ish label like "branch protection: main". */
    path: string;
    text: string;
    /** Deep link, where one exists (an issue, a reverted commit). */
    url?: string;
}
/**
 * Instruction files the team already wrote for coding agents.
 *
 * The single highest-precision source in a repository: someone sat down and
 * wrote imperative rules for a machine to follow. Nothing has to be inferred.
 *
 * Graft's own managed blocks are stripped first. Without that the brain reads
 * back graft's instructions about using graft, and then graft carries them into
 * the same file — a loop that fills the rulebook with itself.
 */
export declare function readAgentInstructions(root: string): HistorySource[];
/** Architecture decision records and the docs that read like them. */
export declare function readDecisionDocs(root: string): HistorySource[];
/**
 * Rules the team already encoded for a machine: linters, formatters, and the
 * checks CI insists on. Nothing to infer — extraction only has to phrase them.
 */
export declare function readCodifiedRules(root: string): HistorySource[];
/** Who must approve what. A hard constraint, stated as a file. */
export declare function readCodeowners(root: string): HistorySource[];
/**
 * Commits that undid another commit.
 *
 * "We tried this and took it back" is a rule available from nowhere else, and
 * it is the one kind of history that says what NOT to do. The body of a revert
 * usually names the commit it undoes and, when the author bothered, why.
 */
export declare function readReverts(root: string, max?: number): HistorySource[];
/**
 * Test names, which are invariants someone wrote deliberately.
 *
 * `never retries on a card decline` is a rule stated as an assertion. Read from
 * the graph's own symbols rather than by re-parsing, so this costs nothing:
 * a test function is already a node.
 *
 * Only names that read like a sentence are kept. `TestFoo` is a label;
 * `rejects an expired token` is a claim about how the system must behave.
 */
export declare function readTestNames(symbolNames: Array<{
    name: string;
    path: string;
}>, max?: number): HistorySource[];
/**
 * Issues closed as not planned.
 *
 * A decision NOT to build something, which is half of what a codebase's rules
 * are and is invisible everywhere else — nothing was committed, so no commit
 * message records it.
 */
export declare function readDeclinedIssues(owner: string, repo: string, token: string, fetchImpl: Fetch, api?: string, max?: number): Promise<HistorySource[]>;
/** Required checks and reviewers on the default branch. */
export declare function readBranchProtection(owner: string, repo: string, branch: string, token: string, fetchImpl: Fetch, api?: string): Promise<HistorySource[]>;
export declare function budgetSources(sources: HistorySource[], maxChars?: number, maxCount?: number): HistorySource[];
/** Repo-relative path, for readers handed an absolute one. */
export declare function relPath(root: string, abs: string): string;
//# sourceMappingURL=sources.d.ts.map