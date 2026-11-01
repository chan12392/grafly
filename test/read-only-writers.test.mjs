import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const entry = fileURLToPath(new URL('../dist/entry.js', import.meta.url));

/** Every file under the repo (outside .git) with its mtime and bytes. */
function snapshot(dir) {
    const out = {};
    for (const name of readdirSync(dir, { recursive: true })) {
        if (name.split(/[\\/]/).includes('.git')) continue;
        const path = join(dir, name);
        const info = statSync(path);
        out[name] = info.isFile() ? `${info.mtimeMs}:${readFileSync(path).toString('base64')}` : 'dir';
    }
    return out;
}

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'grafly-readonly-writers-'));
    t.after(() => {
        assert.equal(dirname(resolve(root)), resolve(tmpdir()));
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
    return { root, repo, run };
}

test('--read-only and GRAFLY_READONLY=1 refuse build and deepidx without writing', t => {
    const { repo, run } = fixture(t);
    const before = snapshot(repo);
    for (const [args, extra] of [[['--read-only', 'build', '.'], {}], [['build', '.', '--read-only'], {}],
        [['build', '.'], { GRAFLY_READONLY: '1' }], [['--read-only', 'deepidx', '.'], {}]]) {
        const r = run(args, extra);
        const label = `${args.join(' ')} ${JSON.stringify(extra)}`;
        assert.notEqual(r.status, 0, `${label} must fail: ${r.stdout}`);
        assert.match(r.stderr, /read-only/, label);
    }
    assert.deepEqual(snapshot(repo), before);
    // Reads stay available under the switch.
    const status = run(['--read-only', 'deepidx', '--status']);
    assert.equal(status.status, 0, status.stderr);
    // Control: the same build without the switch writes the index, so the checks above are meaningful.
    assert.equal(run(['build', '.']).status, 0);
    assert.notDeepEqual(snapshot(repo), before);
});

test('--read-only keeps the preview modes of init, migrate and uninstall', t => {
    const { root, run } = fixture(t);
    // The temp HOME holds the repo, so this also covers out-of-repo (~/.codex, ~/.claude) writes.
    const before = snapshot(root);
    for (const args of [['--read-only', 'init', '.', '--dry-run'], ['--read-only', 'init', '--list-agents'],
        ['--read-only', 'migrate', '.', '--dry-run'], ['--read-only', 'uninstall', '.']]) {
        const r = run(args);
        assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
        assert.doesNotMatch(r.stderr, /refused under --read-only/, args.join(' '));
    }
    const listed = run(['init', '--list-agents'], { GRAFLY_READONLY: '1' });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /claude/);
    assert.deepEqual(snapshot(root), before);
    // Their writing forms are still refused.
    for (const args of [['--read-only', 'uninstall', '.', '-y'], ['--read-only', 'migrate', '.'], ['--read-only', 'init', '.', '-y']]) {
        const r = run(args);
        assert.notEqual(r.status, 0, args.join(' '));
        assert.match(r.stderr, /refused under --read-only/, args.join(' '));
    }
    assert.deepEqual(snapshot(root), before);
});

test('--read-only migrate-index only plans the migration', t => {
    const { repo, run } = fixture(t);
    mkdirSync(join(repo, 'graft/.graph'), { recursive: true });
    writeFileSync(join(repo, 'graft/.graph/wiring.json'), '{}');
    const before = snapshot(repo);
    for (const [args, extra] of [[['--read-only', 'migrate-index', '.'], {}], [['migrate-index', '.'], { GRAFLY_READONLY: '1' }]]) {
        const r = run(args, extra);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(JSON.parse(r.stdout).status, 'planned');
    }
    assert.deepEqual(snapshot(repo), before);
    // Control: without the switch it migrates.
    const migrated = run(['migrate-index', '.']);
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.equal(JSON.parse(migrated.stdout).status, 'migrated');
});
