/**
 * Claude Code session state. The shared `graft/.cache/` pieces (the statusline's
 * `Stats` snapshot and the build lock) live in `../util/state.js` so the graph's
 * pre-query auto-refresh can take the same lock; they are re-exported here so
 * every existing import path keeps working.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cacheDir, readJson, writeJsonAtomic } from '../util/state.js';
export { LOCK_STALE_MS, acquireLock, acquireLockIn, releaseLockIn, cacheDir, emptyStats, patchStats, readStats, releaseLock, resolveContextDir, writeJsonAtomic, writeStats, } from '../util/state.js';
function emptySession() {
    return { lastQuery: null, perAgentQuery: {}, graftReads: 0, sourceReads: 0, savedTokens: 0, injectedPointers: [], nudges: 0 };
}
/** The per-repo session directory holding one `<id>.json` per agent session. */
export function sessionDir(d) { return join(cacheDir(d), 'session'); }
function sessionPath(d, id) { return join(sessionDir(d), `${id}.json`); }
/** Every session id with a file on disk, or `[]` when none exist (never throws).
 *  Shared by the telemetry rollup and `graft stats` so they agree on the set. */
export function listSessionIds(d) {
    try {
        return readdirSync(sessionDir(d)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
    }
    catch {
        return [];
    }
}
export function readSession(d, id) {
    return readJson(sessionPath(d, id)) ?? emptySession();
}
export function writeSession(d, id, s) {
    writeJsonAtomic(sessionPath(d, id), s);
}
//# sourceMappingURL=state.js.map