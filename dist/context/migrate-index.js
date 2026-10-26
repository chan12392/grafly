/** Lossless, explicit migration. Settings in .grafly and original bytes survive. */
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,
    realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import location from './location.cjs';
import { acquireLockIn, releaseLockIn } from '../util/state.js';
import { ensureGitignored } from './node-file.js';
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
function within(root, file) {
    const rel = relative(root, resolve(file));
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../'))
        throw new Error('index migration path escaped its project');
}
function filesIn(dir, prefix = '') {
    const files = [];
    for (const name of readdirSync(join(dir, prefix))) {
        const rel = join(prefix, name), path = join(dir, rel), stat = lstatSync(path);
        if (stat.isSymbolicLink() || name === '.git') throw new Error(`unsafe index entry: ${rel}`);
        if (stat.isDirectory()) files.push(...filesIn(dir, rel));
        else if (stat.isFile()) {
            if (rel !== join('.cache', '.sync.lock')) files.push(rel);
        } else throw new Error(`unsupported index entry: ${rel}`);
    }
    return files;
}
export function migrateIndex(root, { dryRun = false } = {}) {
    root = realpathSync(resolve(root));
    const target = join(root, location.INDEX_DIR);
    const sources = location.LEGACY_INDEX_DIRS.map(name => join(root, name)).filter(location.hasIndexAt);
    if (!sources.length) return { status: 'unchanged', root, target };
    if (sources.length > 1) throw new Error('multiple legacy indexes; choose and reconcile them before migration');
    const source = sources[0];
    within(root, source); within(root, target);
    if (lstatSync(source).isSymbolicLink() || (existsSync(target) && lstatSync(target).isSymbolicLink()))
        throw new Error('index migration refuses linked directories');
    for (const dir of [join(source, '.cache'), join(target, '.cache'), join(target, '.migration-backups')])
        if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error('index migration refuses linked cache/backup');
    // Take both writer locks, including before planning: source files must be stable.
    const locks = [join(source, '.cache'), join(target, '.cache')];
    const held = [];
    try {
        if (!dryRun) for (const dir of locks) {
            if (!acquireLockIn(dir)) throw new Error('index migration waiting for an active index writer');
            held.push(dir);
        }
        // Publish the discovery marker last so readers cannot switch to a partial copy.
        const marker = rel => rel === join('.graph', 'wiring.json') || rel === 'workspace.json';
        const files = filesIn(source).sort((a, b) => Number(marker(a)) - Number(marker(b)));
        const entries = files.map(rel => {
            const from = join(source, rel), to = join(target, rel);
            // Reject links in every existing ancestor, not just the leaf.
            const parts = rel.split(/[\\/]/); let parent = target;
            for (const part of parts) {
                parent = join(parent, part);
                if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error(`linked destination: ${rel}`);
            }
            const hash = digest(from);
            if (existsSync(to) && (!lstatSync(to).isFile() || digest(to) !== hash))
                throw new Error(`index migration conflict: ${rel}; both versions were preserved`);
            return { rel, sha256: hash, bytes: lstatSync(from).size };
        });
        if (dryRun) return { status: 'planned', root, source, target, files: entries.length };
        for (const entry of entries) {
            const from = join(source, entry.rel), to = join(target, entry.rel);
            mkdirSync(resolve(to, '..'), { recursive: true });
            if (!existsSync(to)) copyFileSync(from, to, constants.COPYFILE_EXCL);
            if (digest(to) !== entry.sha256) throw new Error(`index copy verification failed: ${entry.rel}`);
        }
        const backup = join(target, '.migration-backups', randomUUID());
        within(root, backup); mkdirSync(backup, { recursive: true });
        writeFileSync(join(backup, 'receipt.json'), JSON.stringify({ source, target, entries }, null, 2));
        // Verified absolute paths stay under this root; never move a project named grafly
        // unless its child directory was positively identified as an index above.
        renameSync(source, join(backup, 'index'));
        ensureGitignored(root, target);
        return { status: 'migrated', root, source, target, backup, files: entries.length,
            bytes: entries.reduce((total, entry) => total + entry.bytes, 0) };
    } finally { for (const dir of held.reverse()) releaseLockIn(dir); }
}
