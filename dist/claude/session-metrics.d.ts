import { type SessionState } from './state.js';
import type { AgentHost } from '../telemetry/contract.js';
export type ToolKind = 'graft' | 'source';
/** An MCP-style tool name (server-prefixed), as opposed to a native Read/Shell.
 *  Used to hand graft MCP calls to the dedicated MCP hook so a host that fires
 *  BOTH a generic post-tool hook and an MCP hook can't double-count them. */
export declare function isMcpToolName(toolName: string): boolean;
/**
 * Whether a tool name is one of graft's MCP tools, across every host prefix.
 * Anchored on the real name list (`graft_find_code`, its legacy aliases, …), not
 * a loose `includes('graft')`: a third-party MCP tool whose name merely contains
 * "graft" (or a repo working on graft itself) must not count as a graft read —
 * the same care `commandInvokesGraft` takes for the CLI side. Strips the host
 * prefix first (`mcp__graft__graft_find_code`, `MCP:graft_find_code`) by taking
 * the last delimited segment. */
export declare function isGraftMcpTool(toolName: string): boolean;
/** Whether a shell command line invokes the graft CLI (any of its install shapes). */
export declare function commandInvokesGraft(command: string): boolean;
/**
 * Classify one tool use as a graft retrieval, a source read, or neither
 * (an edit, a task spawn, an unrelated shell command — no retrieval signal).
 * `command` is the shell command line when `toolName` is the host's shell tool.
 */
export declare function classifyToolUse(toolName?: string, command?: string): ToolKind | null;
/** Sum every `[graft] tokens saved ≈ N` footer in a blob of tool output. Thin
 *  alias over {@link sumSavingsFooters}, which lives next to the code that writes
 *  the footer so the two can't drift. */
export declare function parseSavings(blob: string): number;
export interface ToolUse {
    /** 'graft' → graftReads++, 'source' → sourceReads++, null/absent → neither. */
    kind?: ToolKind | null;
    /** Tokens the retrieval saved, parsed from its footer. Added to the running total. */
    savedTokens?: number;
    /** The host recording this use. Stamped on the session file (once) so the
     * `session_summary` is attributed correctly no matter which host later flushes it. */
    host?: AgentHost;
}
/**
 * Fold one tool use into a session's counters. A no-op when there is nothing to
 * record (kind null and no savings), so a host can call it unconditionally after
 * every tool without first checking whether the tool was interesting — the
 * no-write path is what keeps it cheap on the Write/Edit/Task majority.
 *
 * Best-effort read-modify-write, not locked — mirroring `patchStats` in
 * util/state.ts. Two tool-use hooks racing on the same session file can lose a
 * count; that is acceptable for an episodic usage estimate (worst case is an
 * undercount by one, never corruption thanks to the atomic write), and a lock
 * here would contend with the build lock these hooks also touch.
 */
export declare function recordToolUse(dir: string, sessionId: string, use: ToolUse): void;
export interface SessionSummary extends SessionState {
    id: string;
}
/** The most-recently-touched session file for a repo, or null when none exist —
 *  what `graft stats` shows by default: the session you were just in. */
export declare function latestSession(dir: string): SessionSummary | null;
/**
 * A one-line-per-fact readout of a session's usage mix — Cursor has no
 * statusline, so this is how you see the numbers the Claude Code bar would show.
 * Reads local JSON only; sends nothing.
 */
/**
 * What this repo's most recent session has actually been paying per million
 * input tokens, or null when no turn has been billed yet.
 *
 * `latestSession` rather than a session id because the callers are CLI and MCP
 * processes answering one query: they know the repo, never the host's session
 * id. The rate belongs to the repo's current session, which is the one whose
 * reply the number is about to appear in.
 */
export declare function sessionInputRate(dir: string): number | null;
export declare function formatSessionStats(s: SessionSummary | null): string;
//# sourceMappingURL=session-metrics.d.ts.map