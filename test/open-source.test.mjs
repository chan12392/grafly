import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { baseUrlFor } from '../dist/brain/link.js';

test('installation leaves existing agent configuration and hooks untouched', t => {
    const home = mkdtempSync(join(tmpdir(), 'grafly-install-opt-in-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const codex = join(home, '.codex');
    const appdata = join(home, 'AppData', 'Roaming');
    mkdirSync(codex, { recursive: true });
    mkdirSync(join(appdata, 'devin'), { recursive: true });
    writeFileSync(join(codex, 'config.toml'), '# user configuration\n');
    writeFileSync(join(appdata, 'devin', 'config.json'), '{"custom":"keep"}\n');
    const snapshot = () => readdirSync(home, { recursive: true, withFileTypes: true })
        .filter(item => item.isFile()).map(item => {
            const path = join(item.parentPath, item.name);
            return [path, readFileSync(path, 'utf8')];
        }).sort();
    const before = snapshot();
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GRAFLY|GRAFT)_|^CI$/i.test(key)));
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/postinstall.mjs', import.meta.url))], {
        cwd: home, encoding: 'utf8', windowsHide: true,
        env: { ...env, HOME: home, USERPROFILE: home, APPDATA: appdata, CODEX_HOME: codex, INIT_CWD: home },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /optional/);
    assert.deepEqual(snapshot(), before);
});

test('Git ignores local credentials and Brain data while allowing the example', t => {
    const dir = mkdtempSync(join(tmpdir(), 'grafly-private-files-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    copyFileSync(new URL('../.gitignore', import.meta.url), join(dir, '.gitignore'));
    const init = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8', windowsHide: true });
    assert.equal(init.status, 0, init.stderr);
    const paths = ['.env', '.env.local', 'key.pem', 'key.key', 'brain-data/brains.json', '.grafly/config.json'];
    const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
        cwd: dir, encoding: 'utf8', windowsHide: true, input: [...paths, '.env.example'].join('\n') + '\n',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/), paths);
});

test('legacy Brain clients reject credential transport over remote plaintext HTTP', t => {
    for (const key of ['GRAFLY_BRAIN_URL', 'GRAFT_BRAIN_URL']) {
        const previous = process.env[key];
        delete process.env[key];
        t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    }
    const link = baseUrl => ({ brainId: 'test', token: 'test', baseUrl });
    for (const url of ['http://example.invalid', 'http://10.0.0.1', 'http://localhost.example.invalid'])
        assert.throws(() => baseUrlFor(link(url)), /HTTPS/);
    for (const url of ['https://example.invalid', 'http://localhost:8788', 'http://127.0.0.1:8788', 'http://[::1]:8788'])
        assert.equal(baseUrlFor(link(url)), url);
});
