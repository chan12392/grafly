/** Compatibility entry point. Live compaction is owned by MoreCoffee. */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const root = process.env.MC_ROOT ?? execFileSync(process.env.MC_PYTHON ?? "python",
    ["-c", "import pathlib, morecoffee; print(pathlib.Path(morecoffee.__file__).resolve().parent.parent)"],
    { encoding: "utf8", windowsHide: true, timeout: 10000 }).trim();
const adapter = await import(pathToFileURL(join(root, "morecoffee/channels/session_host/codex.mjs")).href);
export const { CodexLiveBridge, liveWindow, planLiveCompaction, runLiveProxy } = adapter;
