import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { acquireLock } from '../../dist/mc-runtime/runtime.js';
import { addRules, rewriteBrainSections } from '../../dist/brain/note.js';
import { markRulesChecked } from '../../dist/brain/link.js';

const [mode, dir, id] = process.argv.slice(2);
const lockPath = mode === 'lock' ? join(dir, 'update.lock') : join(dir, '.grafly', '.cache', 'brain.lock');
const read = fs.readFileSync, mkdir = fs.mkdirSync;
let stopped = false;
fs.mkdirSync = function(path, ...args) {
    if (String(path) === lockPath) fs.writeFileSync(join(dir, `${id}.attempt`), 'attempt');
    return mkdir.call(fs, path, ...args);
};
fs.readFileSync = function(path, ...args) {
    const bytes = read.call(fs, path, ...args);
    const target = mode === 'lock' ? String(path).startsWith(lockPath + '/') || String(path).startsWith(lockPath + '\\')
        : String(path) === join(dir, '.grafly', '.cache', 'brain-rules.json');
    if (target && !stopped && mode !== 'busy') {
        stopped = true;
        fs.writeFileSync(join(dir, `${id}.ready`), 'ready');
        const deadline = Date.now() + 10000;
        while (!fs.existsSync(join(dir, `${id}.go`))) {
            if (Date.now() > deadline) throw new Error('fixture barrier timeout');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
    }
    return bytes;
};
syncBuiltinESMExports();

try {
    if (mode === 'lock') {
        const release = acquireLock(dir);
        process.send({ acquired: Boolean(release), pid: process.pid });
        process.on('message', () => { release?.(); process.send({ released: true }); process.disconnect(); });
    } else {
        const result = mode === 'check' ? markRulesChecked(dir, 1234)
            : addRules(dir, [{ rule: `note-${id}`, repoWide: true }], null);
        rewriteBrainSections(dir, '', ['agents']);
        process.send({ accepted: result?.added.length ?? 0 });
        process.disconnect();
    }
} catch(error) {
    process.send({ error: error.message }); process.exitCode = 1; process.disconnect();
}
