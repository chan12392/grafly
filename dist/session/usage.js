/**
 * Context-fullness gauge for Codex rollouts: the host writes a token_count
 * event every turn carrying last_token_usage.input_tokens and
 * model_context_window, so pct = used/window is exact — no estimation.
 */
import { openSync, readSync, closeSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Newest rollout-*.jsonl under <codexHome>/sessions, optionally matching a session id. */
export function latestRollout(codexHome = join(homedir(), ".codex"), sessionId) {
    let best = null;
    const walk = (dir) => {
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const p = join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")
                && (!sessionId || e.name.includes(sessionId))) {
                const mtimeMs = statSync(p).mtimeMs;
                if (!best || mtimeMs > best.mtimeMs) best = { path: p, mtimeMs };
            }
        }
    };
    walk(join(codexHome, "sessions"));
    return best?.path ?? null;
}

/** Last token_count event in the file tail → { used, window, pct } or null. */
export function lastTokenUsage(path, tailBytes = 1 << 19) {
    const size = statSync(path).size;
    const fd = openSync(path, "r");
    try {
        const len = Math.min(size, tailBytes), buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, size - len);
        const lines = buf.toString("utf8").split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
            if (!lines[i].includes('"token_count"')) continue;
            const info = JSON.parse(lines[i])?.payload?.info;
            const used = info?.last_token_usage?.input_tokens, window = info?.model_context_window;
            if (Number.isFinite(used) && Number.isFinite(window) && window > 0)
                return { used, window, pct: (100 * used) / window };
        }
        return null;
    } finally { closeSync(fd); }
}
