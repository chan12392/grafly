import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export function installOutputHook(home = process.env.CODEX_HOME || join(homedir(), ".codex"), { remove = false } = {}) {
    home = resolve(home);
    const path = join(home, "hooks.json");
    const before = existsSync(path) ? readFileSync(path, "utf8") : null;
    const root = before === null ? {} : JSON.parse(before);
    if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("invalid hooks.json");
    const hooks = root.hooks ??= {};
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) throw new Error("invalid hooks");
    const entry = fileURLToPath(new URL("./hook.js", import.meta.url));
    const quote = s => "'" + s.replaceAll("'", process.platform === "win32" ? "''" : "'\\''") + "'";
    const command = `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} ${quote(entry)}`;
    // This marker belongs only to the output hook; other Grafly/security hooks
    // are preserved in place, with identical order and trust identity.
    const own = e => e?.hooks?.length === 1 && /\/dist\/tool-output\/hook\.js["']/.test(e.hooks[0].command?.replaceAll("\\", "/") ?? "");
    const desired = { hooks: [{ type: "command", command, timeout: 5 }] };
    for (const event of ["SessionStart", "UserPromptSubmit"]) {
        const prior = hooks[event] ?? [];
        if (!Array.isArray(prior)) throw new Error(`invalid ${event}`);
        let inserted = false;
        hooks[event] = prior.flatMap(e => {
            if (!own(e)) return [e];
            if (remove || inserted) return [];
            inserted = true; return [desired];
        });
        if (!remove && !inserted) hooks[event].push(desired);
    }
    const after = JSON.stringify(root, null, 2) + "\n";
    if (before !== null && JSON.stringify(JSON.parse(before)) === JSON.stringify(root)) return { path, action: "unchanged" };
    mkdirSync(home, { recursive: true });
    const backup = before === null ? null : `${path}.tool-output-${randomUUID()}.bak`;
    if (backup) copyFileSync(path, backup);
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, after, { flag: "wx" }); renameSync(temp, path);
    return { path, action: remove ? "removed" : "installed", backup,
        note: "New Codex/Orca sessions load this hook. Native hook trust is managed by the host; no permission decisions are granted." };
}
