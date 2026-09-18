/**
 * `graft version` / `graft --version` / `graft upgrade` support.
 *
 * Split out of cli.ts so the formatting helpers can be unit-tested with
 * injected results instead of hitting the network from tests.
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toPosixPath } from "./util/paths.js";
const PKG_NAME = "@nanonets/graft";
/** Locates package.json relative to a module URL (works for both `dist/cli.js`
 * running one level under the published package root, and `src/cli.ts` running
 * one level under the repo root via tsx). */
export function resolvePackageJsonPath(moduleUrl) {
    const moduleDir = dirname(fileURLToPath(moduleUrl));
    const candidates = [resolve(moduleDir, "..", "package.json"), resolve(moduleDir, "package.json")];
    for (const c of candidates) {
        if (existsSync(c))
            return c;
    }
    return candidates[0];
}
/** Reads the version of the graft package this module was loaded from. */
export function readCurrentVersion(moduleUrl) {
    const raw = readFileSync(resolvePackageJsonPath(moduleUrl), "utf8");
    const pkg = JSON.parse(raw);
    return pkg.version ?? "0.0.0";
}
/** True when the running module lives under an npx cache dir (e.g.
 * `~/.npm/_npx/<hash>/node_modules/...`) rather than a regular global install.
 *
 * Normalized first: `fileURLToPath` returns the *platform* separator, so on
 * Windows the cache path is `…\_npx\…` and a bare `includes("/_npx/")` is always
 * false — `graft upgrade` would then run `npm install -g` on top of an npx run.
 * Same hardcoded-`/` mistake as #33; `src/util/paths.ts` exists for exactly this. */
export function isRunningViaNpx(moduleUrl) {
    return toPosixPath(fileURLToPath(moduleUrl)).includes("/_npx/");
}
/** `npm view <pkg> version`, offline-safe: any failure (no npm, no network,
 * timeout) resolves to `{ ok: false }` rather than throwing. */
export function getNpmViewVersion(pkgName = PKG_NAME, timeoutMs = 2000) {
    try {
        const res = spawnSync("npm", ["view", pkgName, "version"], {
            encoding: "utf8",
            timeout: timeoutMs,
            windowsHide: true,
        });
        if (res.error || res.signal || res.status !== 0)
            return { ok: false };
        const version = res.stdout?.trim();
        if (!version)
            return { ok: false };
        return { ok: true, version };
    }
    catch {
        return { ok: false };
    }
}
/** Pure formatter for `graft version` — no I/O, easy to unit-test. */
export function formatVersionReport(current, latest) {
    const lines = [`graft ${current}`];
    if (!latest.ok || !latest.version) {
        lines.push("latest: unreachable (offline?)");
    }
    else if (latest.version === current) {
        lines.push(`latest on npm: ${current} ✓ up to date`);
    }
    else {
        lines.push(`latest on npm: ${latest.version} — run graft upgrade`);
    }
    return lines.join("\n");
}
/** The global npm node_modules dir (handles Homebrew/Windows/volta layouts). */
function globalRoot() {
    try {
        const root = execFileSync("npm", ["root", "-g"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            shell: process.platform === "win32",
        }).trim();
        return root || null;
    }
    catch {
        return null;
    }
}
/** Reads the version actually sitting in the global install, straight from
 * disk — more reliable right after `npm install -g` than re-querying the
 * registry (which just tells you what "latest" is, not what landed locally). */
export function readGlobalInstalledVersion(pkgName = PKG_NAME) {
    const root = globalRoot();
    if (!root)
        return null;
    const pkgJson = join(root, ...pkgName.split("/"), "package.json");
    if (!existsSync(pkgJson))
        return null;
    try {
        const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
        return pkg.version ?? null;
    }
    catch {
        return null;
    }
}
/** Pure formatter for a finished upgrade — no I/O, easy to unit-test. */
export function formatUpgradeReport(result) {
    if (!result.ran) {
        return ("running via npx — npx already fetches the latest graft on every run.\n" +
            "For a permanent install: npm install -g @nanonets/graft");
    }
    if (!result.ok) {
        return `✗ npm install -g ${PKG_NAME}@latest failed${result.errorMessage ? `: ${result.errorMessage}` : ""}`;
    }
    return `graft ${result.oldVersion ?? "?"} → ${result.newVersion ?? result.oldVersion ?? "?"}`;
}
/** Runs `npm install -g @nanonets/graft@latest` (inheriting stdio so the user
 * sees npm's own progress/errors), then re-reads the freshly installed
 * version. No-ops with guidance when running via npx. */
export function runUpgrade(moduleUrl) {
    const oldVersion = readCurrentVersion(moduleUrl);
    if (isRunningViaNpx(moduleUrl)) {
        return { ran: false, ok: true, oldVersion };
    }
    const res = spawnSync("npm", ["install", "-g", `${PKG_NAME}@latest`], { stdio: "inherit" });
    if (res.error || (res.status ?? 1) !== 0) {
        return { ran: true, ok: false, oldVersion, errorMessage: res.error?.message };
    }
    const newVersion = readGlobalInstalledVersion(PKG_NAME) ?? getNpmViewVersion(PKG_NAME).version ?? oldVersion;
    return { ran: true, ok: true, oldVersion, newVersion };
}
//# sourceMappingURL=cli-meta.js.map