/** Compatibility entry point. Live compaction is owned by MoreCoffee. */
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

const ADAPTER = join("morecoffee", "channels", "session_host", "codex.mjs");

function* candidates() {
    if (process.env.MC_ROOT) yield process.env.MC_ROOT;
    try {
        yield execFileSync(process.env.MC_PYTHON ?? "python",
            ["-c", "import pathlib, morecoffee; print(pathlib.Path(morecoffee.__file__).resolve().parent.parent)"],
            { encoding: "utf8", windowsHide: true, timeout: 10000 }).trim();
    } catch { /* not installed in the selected interpreter */ }
    yield join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "morecoffee");
}

let root = null;
for (const candidate of candidates())
    if (existsSync(join(candidate, ADAPTER))) { root = candidate; break; }
if (!root)
    throw new Error("morecoffee_missing: set MC_ROOT to a MoreCoffee source checkout or install morecoffee into the MC_PYTHON interpreter");

const adapter = await import(pathToFileURL(join(root, ADAPTER)).href);
export const { CodexLiveBridge, liveWindow, planLiveCompaction, runLiveProxy } = adapter;
