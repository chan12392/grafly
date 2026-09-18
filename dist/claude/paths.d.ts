/** Absolute path to the graft CLI (`<pkgRoot>/dist/cli.js`), resolved from this module. */
export declare function graftCliPath(): string;
/** Absolute path to this package's `dist/claude` dir. Baked into the generated shims at
 * init time as their primary resolution candidate, so the statusline/hooks find graft
 * without runtime guesswork — correct regardless of how Node was installed. */
export declare function claudeDistDir(): string;
/** Absolute path to a sibling script in the claude dir (e.g. `sync-run.js`). */
export declare function claudeScriptPath(name: string): string;
//# sourceMappingURL=paths.d.ts.map