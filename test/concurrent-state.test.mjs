import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireProcessLock } from '../dist/util/process-lock.js';
import { acquireLock } from '../dist/mc-runtime/runtime.js';
import { addRules, ensureLocalBrain, pushNotes } from '../dist/brain/note.js';
import { connectBrain, pullBrain } from '../dist/brain/connect.js';
import { readLink, readRulesCache, writeLink, writeRulesCache } from '../dist/brain/link.js';

const fixture = () => mkdtempSync(join(tmpdir(), 'grafly-concurrent-state-'));
const worker = fileURLToPath(new URL('./fixtures/concurrent-state-worker.mjs', import.meta.url));
async function until(condition) {
    const deadline = Date.now() + 10000;
    while (!condition()) { assert.ok(Date.now() < deadline, 'fixture timed out'); await delay(10); }
}
function start(t, mode, dir, id) {
    const child = spawn(process.execPath, [worker, mode, dir, id], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const messages = []; let errors = '';
    child.on('message', m => messages.push(m)); child.stderr.on('data', data => errors += data); child.stdout.resume();
    t.after(() => { if (child.exitCode === null) child.kill(); });
    return { child, messages, errors: () => errors };
}
const signal = (dir, id) => writeFileSync(join(dir, `${id}.go`), 'go');
const ready = (dir, id) => until(() => existsSync(join(dir, `${id}.ready`)));

test('simultaneous recovery preserves the winning MC owner for legacy and unique lock files', async t => {
    for (const legacy of [true, false]) {
        const dir = fixture(), path = join(dir, 'update.lock');
        const source = legacy ? 'console.log(process.pid)' :
            `import {acquireLock} from ${JSON.stringify(new URL('../dist/mc-runtime/runtime.js', import.meta.url).href)}; acquireLock(process.argv[1]); console.log(process.pid);`;
        const exited = spawnSync(process.execPath, ['--input-type=module', '-e', source, dir], { encoding: 'utf8', windowsHide: true });
        assert.equal(exited.status, 0, exited.stderr);
        if (legacy) { mkdirSync(path); writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: Number(exited.stdout.trim()) })); }
        const a = start(t, 'lock', dir, 'A'), b = start(t, 'lock', dir, 'B');
        await Promise.all([ready(dir, 'A'), ready(dir, 'B')]);
        signal(dir, 'A'); await until(() => a.messages.length);
        assert.equal(a.messages[0].acquired, true, a.errors());
        signal(dir, 'B'); await until(() => b.messages.length);
        assert.equal(b.messages[0].acquired, false, b.errors());
        const names = readdirSync(path);
        assert.equal(names.length, 1);
        assert.equal(JSON.parse(readFileSync(join(path, names[0]))).pid, a.messages[0].pid);
        b.child.send('release'); await until(() => b.messages.length === 2);
        assert.equal(acquireLock(dir), null);
        a.child.send('release'); await until(() => a.messages.length === 2);
        const release = acquireLock(dir); assert.equal(typeof release, 'function'); release();
    }
});

test('repeated release cannot delete a successor; incomplete, live legacy and linked ownership fail closed', () => {
    const dir = fixture(), path = join(dir, 'lock');
    const first = acquireProcessLock(path); first();
    const second = acquireProcessLock(path); first();
    assert.equal(acquireProcessLock(path), null); second();
    mkdirSync(path); assert.equal(acquireProcessLock(path), null);
    writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: process.pid }));
    assert.equal(acquireProcessLock(path), null);
    writeFileSync(join(path, 'unknown'), 'preserve');
    assert.equal(acquireProcessLock(path), null);
    const target = join(dir, 'target'); mkdirSync(target);
    writeFileSync(join(target, 'owner.json'), '{"pid":2147483647}');
    const linked = join(dir, 'linked'); symlinkSync(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(acquireProcessLock(linked), null);
    assert.equal(readFileSync(join(target, 'owner.json'), 'utf8'), '{"pid":2147483647}');
    const hard = join(dir, 'hard'); mkdirSync(hard); linkSync(join(target, 'owner.json'), join(hard, 'owner.json'));
    assert.equal(acquireProcessLock(hard), null);
});

test('concurrent notes and checked-at writes preserve both rules and instruction delivery', async t => {
    for (const modes of [['note', 'note'], ['check', 'note'], ['note', 'check']]) {
        const dir = fixture(); ensureLocalBrain(dir);
        writeRulesCache(dir, { brainId: 'local', fetchedAt: 0, rules: [] });
        const a = start(t, modes[0], dir, 'A'); await ready(dir, 'A');
        const b = start(t, modes[1], dir, 'B');
        await until(() => existsSync(join(dir, 'B.attempt')));
        assert.equal(existsSync(join(dir, 'B.ready')), false, 'second writer must wait before reading the cache');
        signal(dir, 'A'); await ready(dir, 'B'); signal(dir, 'B');
        await until(() => a.messages.length && b.messages.length);
        assert.equal(a.messages[0].error, undefined, a.errors()); assert.equal(b.messages[0].error, undefined, b.errors());
        const expected = ['A', 'B'].filter((_, i) => modes[i] === 'note').map(id => `note-${id}`);
        const cache = readRulesCache(dir);
        assert.deepEqual(cache.rules.map(r => r.rule).sort(), expected);
        if (modes.includes('check')) assert.equal(cache.checkedAt, 1234);
        for (const rule of expected) assert.ok(readFileSync(join(dir, 'AGENTS.md'), 'utf8').includes(rule));
    }
});

test('lock initialization failures release only their own file and empty directory', () => {
    for (const partial of [false, true]) {
        for (const extra of [false, true]) {
            const path = join(fixture(), 'lock');
            const write = fs.writeFileSync;
            fs.writeFileSync = (fd, ...args) => {
                assert.equal(typeof fd, 'number');
                if (partial) write(fd, '{');
                if (extra) write(join(path, 'unknown'), 'preserve');
                throw Object.assign(new Error('simulated full disk'), { code: 'ENOSPC' });
            };
            syncBuiltinESMExports();
            try { assert.throws(() => acquireProcessLock(path), { code: 'ENOSPC' }); }
            finally { fs.writeFileSync = write; syncBuiltinESMExports(); }
            if (extra) {
                assert.deepEqual(readdirSync(path), ['unknown']);
                assert.equal(acquireProcessLock(path), null);
            } else {
                assert.equal(existsSync(path), false);
                const release = acquireProcessLock(path); assert.equal(typeof release, 'function'); release();
            }
        }
    }
});

test('a busy Brain mutation fails without reporting a successful note', async t => {
    const dir = fixture(); ensureLocalBrain(dir);
    const release = acquireProcessLock(join(dir, '.grafly', '.cache', 'brain.lock'));
    try {
        const child = start(t, 'busy', dir, 'busy'); await until(() => child.messages.length);
        assert.match(child.messages[0].error, /Brain state is busy/);
        assert.equal(child.messages[0].accepted, undefined);
        assert.equal(readRulesCache(dir), null);
    } finally { release(); }
});

test('pulls preserve notes, adopt server copies, and reject superseded or changed-connection responses', async () => {
    const dir = fixture();
    const link = { brainId: 'one', token: 'one-token', baseUrl: 'https://brain.invalid' };
    writeLink(dir, link); writeRulesCache(dir, { brainId: 'one', fetchedAt: 0, rules: [] });
    let respond;
    const pending = pullBrain(dir, { home: '', ids: ['agents'], fetchImpl: () => new Promise(resolve => { respond = resolve; }) });
    addRules(dir, [{ rule: 'arrived during fetch', repoWide: true }], null);
    respond({ ok: true, json: async () => ({ anchors: [] }) }); await pending;
    assert.deepEqual(readRulesCache(dir).rules.map(r => r.rule), ['arrived during fetch']);
    assert.match(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), /arrived during fetch/);
    await pullBrain(dir, { home: '', ids: ['agents'], fetchImpl: async () => ({ ok: true, json: async () =>
        ({ anchors: [{ rule_id: 'push-server', symbol: '', rule: 'arrived during fetch' }] }) }) });
    assert.equal(readRulesCache(dir).rules.length, 1);
    assert.equal(readRulesCache(dir).rules[0].ruleId, 'push-server');
    const beforeRemoval = pullBrain(dir, { home: '', ids: ['agents'], fetchImpl: () => new Promise(resolve => { respond = resolve; }) });
    await pullBrain(dir, { home: '', ids: ['agents'], fetchImpl: async () => ({ ok: true, json: async () => ({ anchors: [] }) }) });
    respond({ ok: true, json: async () => ({ anchors: [{ rule_id: 'push-server', symbol: '', rule: 'arrived during fetch' }] }) });
    assert.match((await beforeRemoval).warning, /newer Brain pull/);
    assert.deepEqual(readRulesCache(dir).rules, []);
    assert.doesNotMatch(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), /arrived during fetch/);
    const stale = pullBrain(dir, { home: '', ids: ['agents'], fetchImpl: () => new Promise(resolve => { respond = resolve; }) });
    await connectBrain(dir, { ...link, brainId: 'two' }, { home: '', ids: ['agents'], fetchImpl: async () =>
        ({ ok: true, json: async () => ({ anchors: [{ symbol: '', rule: 'new connection' }] }) }) });
    respond({ ok: true, json: async () => ({ anchors: [{ symbol: '', rule: 'old connection' }] }) });
    assert.match((await stale).warning, /connection changed/);
    assert.equal(readLink(dir).brainId, 'two');
    assert.deepEqual(readRulesCache(dir).rules.map(r => r.rule), ['new connection']);
    assert.doesNotMatch(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), /old connection/);
    const push = await pushNotes(dir, link, [{ rule: 'old note' }], () => { throw new Error('must not send'); });
    assert.match(push.warning, /connection changed/);
    const malformed = await pullBrain(dir, { home: '', ids: ['agents'], fetchImpl: async () =>
        ({ ok: true, json: async () => ({ anchors: [{ symbol: '', rule: 42 }, { symbol: 42, rule: 'bad anchor' }, { symbol: '', rule: 'valid' }] }) }) });
    assert.equal(malformed.ruleCount, 1);
    assert.deepEqual(readRulesCache(dir).rules.map(r => r.rule), ['valid']);
});
