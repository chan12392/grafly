import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A unique owner filename makes stale recovery and repeated release generation-safe. */
export function acquireProcessLock(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const ownerName = `owner-${process.pid}-${randomUUID()}.json`;
    for (let attempt = 0; attempt < 2; attempt++) {
        try { mkdirSync(path, { mode: 0o700 }); }
        catch (error) {
            if (error.code !== 'EEXIST') throw error;
            try {
                const directory = lstatSync(path);
                if (!directory.isDirectory() || directory.isSymbolicLink()) return null;
                const entries = readdirSync(path);
                // Empty/incomplete and unknown ownership stays protected, including a writer still starting.
                if (entries.length !== 1 || !/^(?:owner|owner-\d+-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.json$/.test(entries[0])) return null;
                const oldOwner = join(path, entries[0]), stat = lstatSync(oldOwner);
                if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024) return null;
                const owner = JSON.parse(readFileSync(oldOwner, 'utf8'));
                if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) return null;
                if (entries[0] !== 'owner.json' && !entries[0].startsWith(`owner-${owner.pid}-`)) return null;
                try { process.kill(owner.pid, 0); return null; }
                catch (error) { if (error.code !== 'ESRCH') return null; }
                // Only the process that removes this exact generation may remove its empty directory.
                unlinkSync(oldOwner);
                rmdirSync(path);
            } catch { return null; }
            continue;
        }
        const ownerPath = join(path, ownerName);
        let created = false;
        try {
            const fd = openSync(ownerPath, 'wx', 0o600);
            created = true;
            try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); }
            finally { closeSync(fd); }
        } catch (error) {
            if (created) {
                try { unlinkSync(ownerPath); } catch { /* Preserve unexpected contents. */ }
            }
            try { rmdirSync(path); } catch { /* Only remove our empty initialization directory. */ }
            throw error;
        }
        return () => {
            try { unlinkSync(ownerPath); } catch { return; }
            try { rmdirSync(path); } catch { /* Unexpected files remain protected. */ }
        };
    }
    return null;
}
