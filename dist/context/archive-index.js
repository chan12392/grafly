// Remove only generated index artifacts. .grafly also owns private runtime/settings.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
export function archiveIndex(dir, apply = true) {
    dir = resolve(dir);
    if (!existsSync(dir)) return 'absent';
    if (lstatSync(dir).isSymbolicLink()) throw new Error('refusing linked index directory');
    const names = readdirSync(dir).filter(name => ['.graph', '.cache', 'manifest.json', 'workspace.json', 'INDEX.md'].includes(name) ||
        (name.endsWith('.md') && !lstatSync(join(dir, name)).isSymbolicLink() && readFileSync(join(dir, name), 'utf8').includes('<!-- context:generated:start -->')));
    if (!names.length) return 'absent';
    if (!apply) return 'would-remove';
    const history = join(dir, '.index-history');
    if (existsSync(history) && lstatSync(history).isSymbolicLink()) throw new Error('refusing linked index history');
    const backup = join(history, randomUUID());
    for (const name of names) {
        const from = resolve(dir, name), rel = relative(dir, from);
        if (!rel || isAbsolute(rel) || rel.startsWith('..') || lstatSync(from).isSymbolicLink()) throw new Error('unsafe index artifact');
    }
    mkdirSync(backup, { recursive: true });
    for (const name of names) renameSync(join(dir, name), join(backup, name));
    return 'removed';
}
