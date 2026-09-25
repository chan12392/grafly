/**
 * `grafly version` / `grafly --version` / `grafly upgrade` support.
 *
 * Split out of cli.ts so the formatting helpers can be unit-tested with
 * injected results instead of hitting the network from tests.
 */
import { existsSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toPosixPath } from "./util/paths.js";
const PKG_NAME = process.env.GRAFLY_NPM_PACKAGE ?? "";
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
    if (!pkgName)
        return { ok: false };
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
    const lines = [`grafly ${current}`];
    if (!latest.ok || !latest.version) {
        lines.push("latest: unreachable (offline?)");
    }
    else if (latest.version === current) {
        lines.push(`latest on npm: ${current} ✓ up to date`);
    }
    else {
        lines.push(`latest on npm: ${latest.version} — run grafly upgrade`);
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
/** The directory the running module's package.json lives in. */
export function packageRoot(moduleUrl) {
    return dirname(resolvePackageJsonPath(moduleUrl));
}
/** Private-fork installs are npm-linked checkouts — the update path is `git
 * pull` in the package's own repo, not a registry. `dist/` IS the product, so
 * a fast-forward pull upgrades the installed CLI byte-for-byte. */
export function isGitCheckout(dir) {
    return existsSync(join(dir, ".git"));
}
function gitRev(dir) {
    try {
        const res = spawnSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], {
            encoding: "utf8", timeout: 10000, windowsHide: true,
        });
        return res.status === 0 ? res.stdout.trim() : null;
    }
    catch {
        return null;
    }
}
/** Pure formatter for a finished upgrade — no I/O, easy to unit-test. */
export function formatUpgradeReport(result) {
    if (!result.ran) {
        if (result.reason === "unconfigured")
            return "upgrade: no git checkout or GRAFLY_NPM_PACKAGE — reinstall Grafly from its source instead.";
        return "running via npx — use your configured Grafly package source for upgrades.";
    }
    if (!result.ok) {
        const what = result.source === "git" ? "git pull --ff-only" : `npm install -g ${PKG_NAME}@latest`;
        return `✗ ${what} failed${result.errorMessage ? `: ${result.errorMessage}` : ""}`;
    }
    if (result.source === "git" && !result.pulled)
        return `grafly ${result.oldVersion ?? "?"} already up to date (${result.rev ?? "?"})`;
    return `grafly ${result.oldVersion ?? "?"} → ${result.newVersion ?? result.oldVersion ?? "?"}${result.rev ? ` (${result.rev})` : ""}`;
}
/** Upgrade path, picked by install shape:
 *  - package dir is a git checkout (npm link / clone install) → `git pull --ff-only`;
 *  - GRAFLY_NPM_PACKAGE set → `npm install -g <pkg>@latest`;
 *  - neither → report disabled. No-ops via npx. `spawn` is injectable for tests. */
export function runUpgrade(moduleUrl, { spawn = spawnSync } = {}) {
    const oldVersion = readCurrentVersion(moduleUrl);
    const root = packageRoot(moduleUrl);
    if (isGitCheckout(root)) {
        if (isRunningViaNpx(moduleUrl))
            return { ran: false, ok: true, oldVersion };
        const revBefore = gitRev(root);
        const res = spawn("git", ["-C", root, "pull", "--ff-only"], {
            encoding: "utf8", timeout: 120000, windowsHide: true,
        });
        if (res.error || (res.status ?? 1) !== 0) {
            return { ran: true, ok: false, source: "git", oldVersion,
                errorMessage: (res.stderr || res.error?.message || "").trim().slice(0, 300) };
        }
        return { ran: true, ok: true, source: "git", oldVersion,
            newVersion: readCurrentVersion(moduleUrl), pulled: gitRev(root) !== revBefore, rev: gitRev(root) };
    }
    if (!PKG_NAME)
        return { ran: false, ok: false, oldVersion, reason: "unconfigured" };
    if (isRunningViaNpx(moduleUrl)) {
        return { ran: false, ok: true, oldVersion };
    }
    const res = spawn("npm", ["install", "-g", `${PKG_NAME}@latest`], { stdio: "inherit" });
    if (res.error || (res.status ?? 1) !== 0) {
        return { ran: true, ok: false, source: "npm", oldVersion, errorMessage: res.error?.message };
    }
    const newVersion = readGlobalInstalledVersion(PKG_NAME) ?? getNpmViewVersion(PKG_NAME).version ?? oldVersion;
    return { ran: true, ok: true, source: "npm", oldVersion, newVersion };
}
