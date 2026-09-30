import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('PowerShell gets cached context while the hidden background worker continues', {
    skip: process.platform !== 'win32', timeout: 15000,
}, async t => {
    const dir = mkdtempSync(join(tmpdir(), "grafly-bg quote'-"));
    const marker = join(dir, 'worker.json'), done = join(dir, 'done');
    const arg = 'space apostrophe\' dollar$ backtick` quote" trailing\\';
    const worker = join(dir, 'worker.cjs'), parent = join(dir, 'hook.cjs');
    const helper = fileURLToPath(new URL('../dist/util/background.cjs', import.meta.url));
    writeFileSync(worker, `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),env:process.env.GRAFLY_BG_FIXTURE})); setTimeout(()=>fs.writeFileSync(${JSON.stringify(done)},'completed'),5000);`);
    writeFileSync(parent, `require(${JSON.stringify(helper)}).spawnBackground(process.execPath,[${JSON.stringify(worker)},${JSON.stringify(arg)}],{cwd:${JSON.stringify(dir)},env:{...process.env,GRAFLY_BG_FIXTURE:'inherited'}}); console.log('cached index context');`);
    const quote = s => "'" + s.replace(/'/g, "''") + "'";
    const started = Date.now();
    const shell = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `& ${quote(process.execPath)} ${quote(parent)}`], { windowsHide: true });
    let out = '', err = '';
    shell.stdout.on('data', b => { out += b; });
    shell.stderr.on('data', b => { err += b; });
    const exit = await new Promise((r, reject) => { shell.on('error', reject); shell.on('close', r); });
    const elapsed = Date.now() - started;
    assert.equal(exit, 0, err);
    assert.match(out, /cached index context/);
    assert.ok(elapsed < 4000, `hook waited ${elapsed}ms for a 5s worker`);
    assert.equal(existsSync(done), false, 'worker must outlive the hook');
    const deadline = Date.now() + 10000;
    while (!existsSync(done) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    assert.equal(existsSync(done), true, 'background work must complete after the hook returns');
    assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), { args: [arg], cwd: dir, env: 'inherited' });
    t.diagnostic(`cached context delivered in ${elapsed}ms; background completed later`);
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
    rmSync(dir, { recursive: true, force: true });
});
