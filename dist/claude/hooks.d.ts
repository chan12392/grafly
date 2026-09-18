export declare function underGraft(dir: string, file: string): boolean;
/**
 * How long the prompt hook may let `graft ask` run — derived from the budget that is
 * *actually installed* in this repo's `.claude/settings.json`, not from what the
 * current version of `settings-merge.ts` would install.
 *
 * A query now brings the graph up to date first, so `graft init` raises the
 * UserPromptSubmit budget to 15s to cover the one cold rebuild after an upgrade. But
 * `mergeGraftSettings` only runs during `graft init` — upgrading the npm package does
 * not re-run it. So every repo wired before that change keeps `"timeout": 8000`, and
 * hard-coding a 13s child there means Claude Code kills the hook first: `emit()` and
 * `writeSession()` never run, the turn gets no retrieval pack at all, and the SIGKILLed
 * child can't even release the build lock. Reading the installed number keeps the child
 * strictly inside whatever budget this repo really has.
 */
export declare function promptAskTimeout(dir: string): number;
/**
 * The absolute path of the file a PostToolUse edit touched, across host edit-tool
 * shapes:
 *   - Claude Code (`Write`/`Edit`/`MultiEdit`) states it directly as
 *     `tool_input.file_path` (already absolute).
 *   - Codex (`apply_patch`) carries the whole patch in `tool_input.command` and
 *     names the file in the patch header (`*** Add File:` / `*** Update File:`),
 *     as a repo-relative path — resolved against `dir` here. Take the first
 *     Add/Update target; that one file is enough to mark the graph dirty and
 *     draw a blast radius (the sync re-checks the whole tree anyway).
 * Returns null when neither shape yields a path, so the hook stays a clean no-op.
 */
export declare function editedFilePath(input: any, dir: string): string | null;
/**
 * The "you're working in backend/, weight it" hint: on a multi-scope repo,
 * narrow the prompt hook's `ask` call to whatever scope the last-edited file
 * (`stats.lastFile`, captured at {@link handlePostEdit}) sits in.
 *
 * `lastFile` is only a basename (not a repo-relative path — see
 * `handlePostEdit`), so this is a best-effort lookup against the CURRENT
 * graph: any file node whose path ends in `/<lastFile>` (or equals it, for a
 * repo-root file). Fails soft in every direction a hook must never crash on —
 * no graph, a single-scope graph, a lastFile no longer in the graph (moved,
 * deleted, or edited before the first build), or a basename that lands in
 * more than one scope (ambiguous: could be either sub-project) all skip the
 * hint silently, logging one line to stderr so the miss is visible without
 * ever failing the hook.
 */
export declare function lastFileScopeHint(dir: string, lastFile: string | null | undefined): string | null;
export declare function main(event: string): Promise<void>;
//# sourceMappingURL=hooks.d.ts.map