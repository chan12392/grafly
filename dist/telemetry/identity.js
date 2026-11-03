/**
 * The two identifiers, and why neither of them identifies anyone.
 *
 *   • install id — one per machine, in `~/.grafly/telemetry.json`, beside the
 *     update-check cache that already lives there. Lets us count people rather
 *     than events, so a dev running forty queries is one user and not forty.
 *   • repo id — one per checkout, in `grafly/.cache/`. Activation and retention
 *     for Grafly are per-repo facts ("did this repo ever get past build?"), and
 *     the install id alone cannot express them.
 *
 * Both are `randomUUID()`. Not a machine id, not a hash of the git remote, not
 * derived from anything real — a coin flip, written down. A hash would at least
 * be guessable by us (we could hash a public repo URL and look for it); a random
 * UUID cannot be reversed or confirmed even in principle. Deleting `~/.grafly/`
 * or `graft/` deletes them, and the user simply looks like someone new.
 *
 * Every function here is fail-soft: an unwritable home is a very common state
 * (a locked-down CI image, a read-only container) and it must cost the caller
 * nothing. A failed persist yields an ephemeral id for this process — still
 * anonymous, just not stable — and never a throw.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cacheDir, readJson, writeJsonAtomic } from '../util/state.js';
export function statePath(home = homedir()) {
    return join(home, '.grafly', 'telemetry.json');
}
export function readState(home) {
    return readJson(statePath(home));
}
/** Read-modify-write. Not atomic across processes; a lost update costs at most a
 *  duplicated notice or an extra flush attempt, never corruption. */
export function patchState(patch, home) {
    const next = { ...(readState(home) ?? { installId: randomUUID() }), ...patch };
    try {
        writeJsonAtomic(statePath(home), next);
    }
    catch { /* unwritable home — in-memory only */ }
    return next;
}
/** The install id, minted on first call. */
export function installId(home) {
    const existing = readState(home);
    if (existing?.installId)
        return { id: existing.installId, firstRun: false };
    const id = randomUUID();
    try {
        writeJsonAtomic(statePath(home), { ...(existing ?? {}), installId: id });
        return { id, firstRun: true };
    }
    catch {
        // Unwritable home: use the id for this process rather than failing closed.
        // Reported as firstRun:false so a machine that can never persist doesn't
        // send a first_run event on every single command.
        return { id, firstRun: false };
    }
}
/**
 * The repo id, in `grafly/.cache/` rather than `.graft/config.json`.
 *
 * `.graft/config.json` would have been the tidier home, but writing it runs
 * `ensureBuildConfigIgnored`, which appends to the repo's `.gitignore`. Minting
 * an id during a read-only `grafly ask` must not modify a file the user has
 * committed. `grafly/.cache/` is already derived, already git-ignored, and
 * already where every other per-repo sidecar lives.
 */
export function repoId(repo) {
    const path = join(cacheDir(repo), 'telemetry-repo-id.json');
    const existing = readJson(path);
    if (existing?.repoId)
        return existing.repoId;
    const id = randomUUID();
    try {
        writeJsonAtomic(path, { repoId: id });
    }
    catch { /* unwritable — ephemeral */ }
    return id;
}
