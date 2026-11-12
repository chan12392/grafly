import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readGraph, wiringPath } from '../dist/graph/write.js';
import { symbolModel, installConsumerModel } from './fixtures/mc-model.mjs';

test('stdio requests preserve service executable lookup even when a request tries to override it', t => {
    const root = mkdtempSync(join(tmpdir(), 'grafly-resident-env-'));
    t.after(() => {
        assert.equal(dirname(resolve(root)), resolve(tmpdir()));
        assert.ok(root.includes('grafly-resident-env-'));
        rmSync(root, { recursive: true, force: true });
    });
    const home = join(root, 'service'), emptyPath = join(root, 'empty-path');
    mkdirSync(home); mkdirSync(emptyPath);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ xerjUrl: null }));
    const repos = ['inherited', 'overridden', 'restored'].map(name => {
        const cwd = join(root, name);
        mkdirSync(cwd);
        const git = spawnSync('git', ['init', '--quiet'], { cwd, encoding: 'utf8', windowsHide: true });
        assert.equal(git.status, 0, git.stderr);
        writeFileSync(join(cwd, '.gitignore'), 'private.js\n.grafly/\n');
        writeFileSync(join(cwd, 'public.js'), 'export function publicSymbol() {}');
        writeFileSync(join(cwd, 'private.js'), 'export function privateSymbol() {}');
        return cwd;
    });
    const requests = repos.map((cwd, i) => ({ id: i + 1, command: 'build', argv: ['build', '.'], cwd,
        ...(i === 1 ? { env: { PATH: emptyPath, PATHEXT: '.EXE' } } : {}) }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GRAFLY_|GRAFT_)/i.test(key)));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/entry.js', import.meta.url)), 'serve', '--stdio'], {
        cwd: root, env: { ...env, GRAFLY_SEARCH_HOME: home, HOME: root, USERPROFILE: root }, windowsHide: true,
        encoding: 'utf8', timeout: 120000, input: requests.map(r => JSON.stringify(r)).join('\n') + '\n',
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const responses = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    for (let i = 0; i < repos.length; i++) {
        const response = responses.find(row => row.id === i + 1);
        assert.equal(response?.exitCode, 0, JSON.stringify(response));
        const paths = [...new Set(readGraph(wiringPath(join(repos[i], '.grafly'))).nodes.map(n => n.path))].sort();
        assert.deepEqual(paths, ['public.js']);
    }
});

test('resident clients select inference models separately from their feedback home on each request', async t => {
    const root = mkdtempSync(join(tmpdir(), 'grafly-resident-learning-'));
    let daemon;
    t.after(async () => {
        if (daemon?.pid && daemon.exitCode === null && daemon.signalCode === null) {
            const exited = once(daemon, 'exit');
            daemon.stdin.end();
            const timeout = setTimeout(() => daemon.kill(), 5000);
            await exited;
            clearTimeout(timeout);
        }
        assert.equal(dirname(resolve(root)), resolve(tmpdir()));
        assert.ok(root.includes('grafly-resident-learning-'));
        rmSync(root, { recursive: true, force: true });
    });
    const repo = join(root, 'repo'), service = join(root, 'service');
    const serviceHome = join(root, 'service-learning'), learnedHome = join(root, 'learned'), seedHome = join(root, 'seed');
    for (const dir of [repo, service, serviceHome, learnedHome, seedHome, join(learnedHome, 'models')]) mkdirSync(dir, { recursive: true });
    for (const home of [serviceHome, learnedHome, seedHome])
        writeFileSync(join(home, 'config.json'), JSON.stringify({ schema: 'mc.learning.config.v1', enabled: true }));
    writeFileSync(join(service, 'config.json'), JSON.stringify({ xerjUrl: null }));
    for (const name of ['a', 'b']) writeFileSync(join(repo, name + '.js'), 'export function choose() {}');
    const modelHome = join(root, 'consumer'), emptyModels = join(root, 'empty-models');
    const sha = installConsumerModel(modelHome, symbolModel(0.1));
    writeFileSync(join(learnedHome, 'models', sha + '.json'), JSON.stringify(symbolModel(0.1)));
    writeFileSync(join(learnedHome, 'active.json'), JSON.stringify({ schema: 'mc.learning.active.v1', models: { symbol_disambiguation: sha } }));
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GRAFLY_|GRAFT_|MC_)/i.test(key))),
        HOME: root, USERPROFILE: root, GRAFLY_MC_RUNTIME_HOME: join(root, 'unconfigured-runtime'), GRAFLY_SEARCH_HOME: service, GRAFLY_MC: '0' };
    const entry = fileURLToPath(new URL('../dist/entry.js', import.meta.url));
    const run = (argv, requestEnv) => {
        const result = spawnSync(process.execPath, [entry, ...argv], { cwd: repo, env: requestEnv, encoding: 'utf8', timeout: 20000, windowsHide: true });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
    };
    run(['build', '.'], { ...env, MC_LEARNING_HOME: serviceHome });
    daemon = spawn(process.execPath, [entry, 'serve', '--stdio'], { cwd: repo, env: { ...env, MC_LEARNING_HOME: serviceHome },
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    daemon.stderr.on('data', chunk => { errors += chunk; });
    await new Promise((done, fail) => {
        const timeout = setTimeout(() => fail(new Error('Resident startup timeout: ' + errors)), 10000);
        daemon.once('error', error => { clearTimeout(timeout); fail(error); });
        daemon.once('exit', code => { clearTimeout(timeout); fail(new Error(`Resident exited ${code}: ${errors}`)); });
        daemon.stdout.on('data', chunk => {
            output += chunk;
            if (output.includes('\n')) { clearTimeout(timeout); done(); }
        });
    });
    const callers = requestEnv => JSON.parse(run(['callers', 'choose', '--json'], { ...env, ...requestEnv })).circuit;
    assert.equal(callers({ MC_LEARNING_HOME: learnedHome, MC_MODEL_HOME: modelHome, GRAFLY_NO_DAEMON: '1' }).model_sha256, sha);
    for (const [home, models, expected] of [[learnedHome, modelHome, sha], [seedHome, emptyModels, null], [learnedHome, modelHome, sha]])
        assert.equal(callers({ MC_LEARNING_HOME: home, MC_MODEL_HOME: models }).model_sha256, expected);
    assert.equal(callers({ MC_LEARNING_HOME: seedHome, MC_MODEL_HOME: modelHome, MC_MODEL_DISABLED: '1' }).model_sha256, null);
    assert.equal(callers({ MC_LEARNING_HOME: seedHome, MC_MODEL_HOME: modelHome }).model_sha256, sha);
    assert.equal(JSON.parse(run(['daemon', 'status'], env)).queries, 5);
    assert.equal(existsSync(join(serviceHome, 'inbox')), false);
    for (const home of [learnedHome, seedHome]) assert.equal(readdirSync(join(home, 'inbox')).length, 1);
});
