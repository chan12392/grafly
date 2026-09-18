/** Locates package.json relative to a module URL (works for both `dist/cli.js`
 * running one level under the published package root, and `src/cli.ts` running
 * one level under the repo root via tsx). */
export declare function resolvePackageJsonPath(moduleUrl: string): string;
/** Reads the version of the graft package this module was loaded from. */
export declare function readCurrentVersion(moduleUrl: string): string;
/** True when the running module lives under an npx cache dir (e.g.
 * `~/.npm/_npx/<hash>/node_modules/...`) rather than a regular global install.
 *
 * Normalized first: `fileURLToPath` returns the *platform* separator, so on
 * Windows the cache path is `…\_npx\…` and a bare `includes("/_npx/")` is always
 * false — `graft upgrade` would then run `npm install -g` on top of an npx run.
 * Same hardcoded-`/` mistake as #33; `src/util/paths.ts` exists for exactly this. */
export declare function isRunningViaNpx(moduleUrl: string): boolean;
export interface NpmViewResult {
    ok: boolean;
    version?: string;
}
/** `npm view <pkg> version`, offline-safe: any failure (no npm, no network,
 * timeout) resolves to `{ ok: false }` rather than throwing. */
export declare function getNpmViewVersion(pkgName?: string, timeoutMs?: number): NpmViewResult;
/** Pure formatter for `graft version` — no I/O, easy to unit-test. */
export declare function formatVersionReport(current: string, latest: NpmViewResult): string;
/** Reads the version actually sitting in the global install, straight from
 * disk — more reliable right after `npm install -g` than re-querying the
 * registry (which just tells you what "latest" is, not what landed locally). */
export declare function readGlobalInstalledVersion(pkgName?: string): string | null;
export interface UpgradeResult {
    /** True when `npm install -g` actually ran (false for the npx no-op path). */
    ran: boolean;
    ok: boolean;
    /** Present when ran=true and the install failed. */
    errorMessage?: string;
    oldVersion?: string;
    newVersion?: string;
}
/** Pure formatter for a finished upgrade — no I/O, easy to unit-test. */
export declare function formatUpgradeReport(result: UpgradeResult): string;
/** Runs `npm install -g @nanonets/graft@latest` (inheriting stdio so the user
 * sees npm's own progress/errors), then re-reads the freshly installed
 * version. No-ops with guidance when running via npx. */
export declare function runUpgrade(moduleUrl: string): UpgradeResult;
//# sourceMappingURL=cli-meta.d.ts.map