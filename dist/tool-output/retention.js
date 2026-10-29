/** Local raw-output quota. Active writers may exceed it; never follow links. */
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { lstatSync, readdirSync, realpathSync, renameSync, rmdirSync,
  unlinkSync, writeFileSync } from 'node:fs';
import { alive, smallJSON, safeRoot, sameFile, lock } from '../util/retention.js';

export const ARCHIVE_BUDGET = 20 * 1024 * 1024;
export const archiveRoot = () => resolve(process.env.GRAFLY_OUTPUT_DIR || join(homedir(), '.grafly', 'tool-output'));
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const FILES = ['stdout.bin', 'stderr.bin', '.active.json', 'manifest.json'];
const ACTIVE_SCHEMA = 'grafly.tool-output.writer.v1';

export function startArchive(dir, id) {
  writeFileSync(join(dir, '.active.json'), JSON.stringify({ schema: ACTIVE_SCHEMA,
    id, pid: process.pid, started_at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
}
export function finishArchive(dir, id) {
  const path = join(dir, '.active.json');
  try {
    const owner = smallJSON(path);
    if (owner.schema === ACTIVE_SCHEMA && owner.id === id && owner.pid === process.pid)
      writeFileSync(path, JSON.stringify({ ...owner, finished_at: new Date().toISOString() }), { flag: 'r+' });
  } catch { /* Leave uncertain ownership protected until its process exits. */ }
}

function inspect(root, name) {
  const deleting = name.startsWith('.gc-');
  const id = deleting ? name.slice(4) : name;
  if (!UUID.test(id)) return null;
  const path = resolve(root, name);
  if (dirname(path) !== root) return null;
  const directory = lstatSync(path);
  if (!directory.isDirectory() || directory.isSymbolicLink() || realpathSync(path) !== path) return null;
  let bytes = 0, safe = true;
  const files = [];
  for (const entry of readdirSync(path)) {
    const stat = lstatSync(join(path, entry));
    if (stat.isFile() && !stat.isSymbolicLink()) bytes += stat.size;
    if (!FILES.includes(entry) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) safe = false;
    files.push({ name: entry, stat });
  }
  let eligible = false, age = directory.birthtimeMs || directory.mtimeMs;
  if (safe) {
    if (files.some(f => f.name === '.active.json')) {
      try {
        const owner = smallJSON(join(path, '.active.json'));
        eligible = owner.schema === ACTIVE_SCHEMA && owner.id === id && Number.isSafeInteger(owner.pid)
          && owner.pid > 0 && (Number.isFinite(Date.parse(owner.finished_at)) || !alive(owner.pid));
        age = Date.parse(owner.started_at) || age;
      } catch { /* corrupt writer marker: protect */ }
    } else if (files.some(f => f.name === 'manifest.json')) {
      try {
        const manifest = smallJSON(join(path, 'manifest.json'));
        eligible = manifest.schema === 'grafly.tool-output.v1' && manifest.id === id;
        age = Date.parse(manifest.started_at) || age;
      } catch { /* unowned or malformed files: protect */ }
    } else if (deleting && files.length === 0) eligible = true;
    // Legacy partial archives without an owner cannot be proven idle: protect.
  }
  return { id, name, path, bytes, eligible, age, files, directory, deleting };
}
function unchanged(before, after) {
  return after?.eligible && before.directory.ino === after.directory.ino
    && before.files.length === after.files.length
    && before.files.every(f => after.files.some(g => g.name === f.name && sameFile(f.stat, g.stat)));
}
function removeRecord(root, record) {
  const target = resolve(root, '.gc-' + record.id);
  if (dirname(record.path) !== root || dirname(target) !== root) return false;
  if (!record.deleting) {
    try { lstatSync(target); return false; } catch (error) { if (error.code !== 'ENOENT') return false; }
    renameSync(record.path, target);
  }
  const claimed = inspect(root, '.gc-' + record.id);
  if (!unchanged(record, claimed)) return false;
  // Nonrecursive deletion only; unexpected children and links are never followed.
  for (const name of FILES) {
    const expected = claimed.files.find(f => f.name === name);
    if (!expected) continue;
    const path = join(target, name), actual = lstatSync(path);
    if (!actual.isFile() || actual.isSymbolicLink() || actual.nlink !== 1 || !sameFile(expected.stat, actual)) return false;
    unlinkSync(path);
  }
  rmdirSync(target);
  return true;
}

export function pruneArchives({ root = archiveRoot(), dryRun = false } = {}) {
  const result = { budget_bytes: ARCHIVE_BUDGET, bytes_before: 0, bytes_after: 0,
    protected_bytes: 0, records: 0, deleted: [], candidates: [], dry_run: dryRun, status: 'ok' };
  let release;
  try {
    root = safeRoot(root);
    release = lock(root);
    if (!release) return { ...result, status: 'busy' };
    const records = [];
    for (const name of readdirSync(root)) {
      try { const record = inspect(root, name); if (record) records.push(record); }
      catch { /* concurrent filesystem change: leave it alone */ }
    }
    result.records = records.length;
    result.bytes_before = result.bytes_after = records.reduce((n, r) => n + r.bytes, 0);
    result.protected_bytes = records.filter(r => !r.eligible).reduce((n, r) => n + r.bytes, 0);
    for (const record of records.filter(r => r.eligible).sort((a, b) => a.age - b.age || a.name.localeCompare(b.name))) {
      if (result.bytes_after <= ARCHIVE_BUDGET && !record.deleting) continue;
      if (!release.owns()) { result.status = 'busy'; break; }
      try {
        if (!unchanged(record, inspect(root, record.name))) continue;
        result.candidates.push(record.id);
        if (dryRun || removeRecord(root, record)) {
          result.bytes_after -= record.bytes;
          if (!dryRun) result.deleted.push(record.id);
        }
      } catch { /* locked file or interrupted deletion: retry on the next sweep */ }
    }
    result.over_budget = result.bytes_after > ARCHIVE_BUDGET;
    return result;
  } catch (error) {
    return { ...result, status: error.code === 'ENOENT' ? 'absent' : 'unavailable' };
  } finally { release?.release(); }
}

export function startArchiveMaintenance(root = archiveRoot(), intervalMs = 60000) {
  pruneArchives({ root });
  const timer = setInterval(() => pruneArchives({ root }), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
