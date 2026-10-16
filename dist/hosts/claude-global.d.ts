import { type ConfigWrite } from './config-write.js';
import type { PlannedWrite } from './plan.js';
/** Same `{ id, path, action }` contract every other writer in this layer reports. */
export type GlobalWrite = ConfigWrite;
/** The directory the user-level shim lives in — the base every hook command names. */
export declare function globalHelpersDir(home: string): string;
/**
 * The files a user-level install would touch — pure, no writes, so `--dry-run` and
 * the picker can report them up front. Both are scoped 'global': they apply to
 * every project opened with Claude Code, not just this one.
 */
export declare function claudeGlobalTargets(home: string): PlannedWrite[];
/**
 * Install the user-level copy: the shim and the hook entries that call it.
 *
 * The shim is written to `home` and the hook commands name it by absolute path, for
 * the reason the repo form can't be reused: `${CLAUDE_PROJECT_DIR}/.claude/helpers/`
 * resolves inside whatever project is open, and the whole point is to work in one
 * that has no such file. `hooksShim(claudeDistDir())` bakes in the installed
 * package's `dist/`, exactly as the Codex install does.
 *
 * Best-effort by contract, like every other writer here: a failure is reported as an
 * action, never raised, so a bad `~/.claude.json` can't fail a `graft init`.
 */
export declare function installClaudeGlobal(home: string): GlobalWrite[];
