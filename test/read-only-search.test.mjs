import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const entry = fileURLToPath(new URL('../dist/entry.js', import.meta.url));

function snapshot(dir) {
    const out = {};
    for (const name of readdirSync(dir, { recursive: true })) {
        const path = join(dir, name);
        const info = statSync(path);
        if (info.isFile()) out[name] = `${info.mtimeMs}:${readFileSync(path).toString('base64')}`;
    }
    return out;
}

test('--read-only and GRAFLY_READONLY=1 leave the saved graph directory untouched', t => {
    const root = mkdtempSync(join(tmpdir(), 'grafly-readonly-'));
    t.after(() => {
        assert.equal(dirname(resolve(root)), resolve(tmpdir()));
        assert.ok(root.includes('grafly-readonly-'));
        rmSync(root, { recursive: true, force: true });
    });
    const home = join(root, 'service'), repo = join(root, 'repo');
    mkdirSync(home); mkdirSync(repo);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ xerjUrl: null }));
    assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: repo, windowsHide: true }).status, 0);
    writeFileSync(join(repo, '.gitignore'), '.grafly/\n');
    writeFileSync(join(repo, 'alpha.js'), 'export function alphaHandler() { return 1; }\n');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GRAFLY_|GRAFT_)/i.test(key)));
    const run = (args, extra = {}) => spawnSync(process.execPath, [entry, ...args], {
        cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 120000,
        env: { ...env, GRAFLY_SEARCH_HOME: home, HOME: root, USERPROFILE: root, ...extra },
    });
    const built = run(['build', '.']);
    assert.equal(built.status, 0, built.stderr);
    // A source edit makes the graph stale, so a normal ask would refresh it.
    writeFileSync(join(repo, 'alpha.js'), 'export function alphaHandler() { return 2; }\nexport function betaHelper() {}\n');
    const ctx = join(repo, '.grafly');
    const before = snapshot(ctx);
    for (const [args, extra] of [[['ask', 'alphaHandler', '.', '--read-only'], {}], [['grep', 'alphaHandler', '.', '--read-only'], {}],
        [['ask', 'alphaHandler', '.'], { GRAFLY_READONLY: '1' }]]) {
        const r = run(args, extra);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /alphaHandler/);
    }
    assert.deepEqual(snapshot(ctx), before);
    // Control: the same ask without read-only writes (refresh or answer cache), so the check above is meaningful.
    assert.equal(run(['ask', 'alphaHandler', '.']).status, 0);
    assert.notDeepEqual(snapshot(ctx), before);
});
