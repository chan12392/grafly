import type { PlannedWrite } from './plan.js';
import { type ConfigWrite } from './config-write.js';
/**
 * The files a Cursor-hooks install would touch — pure, no writes. Both are
 * repo-local, so both are scoped 'repo' (they fire only in this repo, matching
 * the Cursor-only, no-global init). Always returns the pair: unlike Codex there
 * is no "is the CLI installed" gate — the repo's own `.cursor/` is what we write.
 */
export declare function cursorHookTargets(repo: string): PlannedWrite[];
/**
 * Install (or refresh) graft's Cursor project hooks in `repo`. Idempotent, and
 * conservative with a hand-edited config: an unparseable or wrong-shaped
 * `hooks.json` is left exactly as-is (reported `skipped-unparseable`) rather than
 * clobbered. Foreign hook entries are preserved; a stale graft entry is replaced
 * so an upgrade re-points to the current shim/sub-command instead of stacking.
 */
export declare function installCursorHooks(repo: string): ConfigWrite[];
//# sourceMappingURL=cursor-hooks.d.ts.map