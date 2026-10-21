/* Shared filesystem ownership checks for regenerable local caches. */
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { lstatSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';

export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
export function smallJSON(path) {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 65536) throw new Error('unsafe metadata');
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function safeRoot(path) {
  const root = resolve(path);
  for (let p = root; ; p = dirname(p)) {
    const s = lstatSync(p);
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('unsafe archive root');
    if (dirname(p) === p) break;
  }
  return realpathSync(root);
}
export function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}
export function lock(root) {
  const path = join(root, '.retention.lock');
  const token = randomUUID(), value = JSON.stringify({ pid: process.pid, token });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, value, { flag: 'wx', mode: 0o600 });
      const owns = () => { try { return smallJSON(path).token === token; } catch { return false; } };
      return { owns, release: () => { if (owns()) try { unlinkSync(path); } catch { /* next sweep */ } } };
    } catch (error) {
      if (error.code !== 'EEXIST') return null;
      try {
        const before = lstatSync(path);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) return null;
        let owner;
        try { owner = smallJSON(path); } catch { /* crash during lock creation */ }
        if (owner ? alive(owner.pid) : Date.now() - before.mtimeMs < 60000) return null;
        if (!sameFile(before, lstatSync(path))) return null;
        unlinkSync(path);
      } catch { return null; }
    }
  }
  return null;
}
