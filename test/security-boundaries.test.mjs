import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, readdirSync, openSync, closeSync, ftruncateSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { hooksShim } from '../dist/claude/shim-template.js';
import { mergeGraftSettings } from '../dist/claude/settings-merge.js';
import { writeGraph, readGraph } from '../dist/graph/write.js';
import { readWorkspace, writeWorkspace } from '../dist/graph/workspace.js';
import { writeOwned } from '../dist/hosts/config-write.js';
import { upsertSection, removeSection, BRAIN_MARKERS } from '../dist/hosts/sections.js';
import { quoteHookPath } from '../dist/hosts/quote-hook-path.js';
import { readNodes } from '../dist/context/node-file.js';
import { listMaterialStats, readMaterials } from '../dist/materials/index.js';
import { serveReadCommand } from '../dist/tool-output/output.js';
import { installOutputHook } from '../dist/tool-output/install.js';
import { requestEnv } from '../dist/search/client.js';
import { writeCards } from '../dist/graph/cards.js';

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'grafly-security-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
}

test('CLI imports do not let a repository dotenv configure the process', t => {
    const root = fixture(t);
    writeFileSync(join(root, '.env'), 'GRAFLY_SECURITY_PROBE=repository-controlled\n');
    for (const entry of ['entry.js', 'cli.js']) {
        const url = pathToFileURL(resolve('dist', entry)).href;
        const code = `process.argv=['node','grafly','--version']; process.on('exit',()=>console.log('PROBE='+String(process.env.GRAFLY_SECURITY_PROBE))); await import(${JSON.stringify(url)});`;
        const env = { ...process.env, GRAFLY_NO_DAEMON: '1', GRAFLY_JUDGMENT_CONFIG: '0' };
        delete env.GRAFLY_SECURITY_PROBE;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /PROBE=undefined/);
    }
});

test('installed hook shims cannot select a newer repository-local package', t => {
    const root = fixture(t);
    const trusted = join(root, 'trusted', 'dist', 'claude');
    const hostile = join(root, 'repo', 'node_modules', 'grafly', 'dist', 'claude');
    for (const [dir, version, marker] of [[trusted, '0.1.0', 'trusted.called'], [hostile, '99.0.0', 'hostile.called']]) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, '..', '..', 'package.json'), JSON.stringify({ type: 'module', version }));
        writeFileSync(join(dir, 'hooks.js'), `import fs from 'node:fs'; export function main(){fs.writeFileSync(${JSON.stringify(join(root, marker))},'called');}`);
    }
    const shim = join(root, 'hook.cjs');
    writeFileSync(shim, hooksShim(trusted));
    const result = spawnSync(process.execPath, [shim, 'session-start'], { cwd: join(root, 'repo'), env: { ...process.env, CLAUDE_PROJECT_DIR: join(root, 'repo') }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(root, 'trusted.called'), 'utf8'), 'called');
    assert.equal(existsSync(join(root, 'hostile.called')), false);
});

test('init retracts executor allowlists while preserving unrelated permissions', () => {
    const { merged } = mergeGraftSettings({ permissions: { allow: ['Bash(grafly:*)', 'Bash(node dist/cli.js:*)', 'Read(src/**)'] } });
    assert.deepEqual(merged.permissions.allow, ['Read(src/**)']);
});

test('automatic self-upgrade requires an explicit opt-in', t => {
    const root = fixture(t), pkg = join(root, 'package'), scripts = join(pkg, 'scripts'), dist = join(pkg, 'dist');
    mkdirSync(scripts, { recursive: true }); mkdirSync(join(dist, 'claude'), { recursive: true }); mkdirSync(join(dist, 'util'));
    copyFileSync(resolve('scripts/grafly-devin-hook.cjs'), join(scripts, 'hook.cjs'));
    writeFileSync(join(dist, 'claude', 'hooks.js'), 'exports.main=()=>{};');
    writeFileSync(join(dist, 'cli.js'), '// fixture: the spawn boundary is captured by background.cjs');
    const marker = join(root, 'spawned.json');
    writeFileSync(join(dist, 'util', 'background.cjs'), 'exports.spawnBackground=(command,args)=>require("node:fs").writeFileSync('
        + JSON.stringify(marker) + ',JSON.stringify({command,args}));');
    const env = { ...process.env, HOME: root, USERPROFILE: root, GRAFLY_NO_AUTO_INDEX: '1', GRAFLY_NO_AUTO_DEEP: '1' };
    for (const key of ['GRAFLY_AUTO_UPDATE', 'GRAFLY_NO_SELF_UPDATE', 'GRAFT_NO_SELF_UPDATE']) delete env[key];
    const run = vars => spawnSync(process.execPath, [join(scripts, 'hook.cjs'), 'session-start'], {
        cwd: root, env: vars, input: JSON.stringify({ cwd: root }), encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    assert.equal(run(env).status, 0);
    assert.equal(existsSync(marker), false);
    assert.equal(run({ ...env, GRAFLY_AUTO_UPDATE: '1' }).status, 0);
    assert.ok(JSON.parse(readFileSync(marker, 'utf8')).args.includes('_self-upgrade'));
});

test('oversized hook stdin stops reading without waiting for EOF', async t => {
    const root = fixture(t), url = pathToFileURL(resolve('dist/util/stdin.js')).href;
    const code = 'import {readStdinText} from ' + JSON.stringify(url)
        + '; try {readStdinText();process.exit(2)} catch(e) {if(!/exceeds/.test(e.message))throw e; console.log("bounded")}';
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: root, windowsHide: true });
    t.after(() => { if (child.exitCode === null) child.kill(); child.stdin.destroy(); });
    let stdout = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stdin.on('error', () => {});
    const exit = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error('stdin did not stop')); }, 5000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    child.stdin.write(Buffer.alloc(2 * 1024 * 1024)); // Deliberately leave stdin open.
    assert.equal(await exit, 0);
    assert.match(stdout, /bounded/);
});

test('repository wiring stamps cannot authorize passive host configuration changes', t => {
    const root = fixture(t);
    const stamp = pathToFileURL(resolve('dist/upkeep.js')).href;
    const upkeep = pathToFileURL(resolve('dist/upkeep-run.js')).href;
    const code = 'import {writeStamp} from ' + JSON.stringify(stamp) + '; import {runUpkeep} from ' + JSON.stringify(upkeep)
        + '; writeStamp(process.cwd(),"0.0.1",["agents"],{global:true,hooks:true}); runUpkeep(process.cwd(),"99.0.0",{background:false,home:process.cwd()});';
    const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: join(root, 'Roaming'), CODEX_HOME: join(root, 'codex'),
        CLAUDE_CONFIG_DIR: join(root, 'claude'), GRAFLY_DEVIN_DIR: join(root, 'devin') };
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(root, 'AGENTS.md')), false);
    assert.equal(existsSync(join(root, 'codex', 'hooks.json')), false);
});

test('index and hook writers reject redirected directories before touching outside files', t => {
    const root = fixture(t), repo = join(root, 'repo'), outside = join(root, 'outside');
    mkdirSync(repo); mkdirSync(outside);
    writeFileSync(join(outside, 'settings.json'), '{"preserve":true}');
    symlinkSync(outside, join(repo, '.grafly'), process.platform === 'win32' ? 'junction' : 'dir');
    symlinkSync(outside, join(repo, '.claude'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => writeGraph({ nodes: [], edges: [] }, join(repo, '.grafly')), /symlink/);
    assert.throws(() => writeOwned('settings', join(repo, '.claude', 'settings.json'), '{}'), /symlink/);
    assert.deepEqual(readdirSync(outside), ['settings.json']);
    assert.equal(readFileSync(join(outside, 'settings.json'), 'utf8'), '{"preserve":true}');
    const cards = join(root, 'cards');
    mkdirSync(cards);
    symlinkSync(outside, join(cards, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => writeCards({ nodes: [{ id: 'src/a.js', name: 'a.js', kind: 'file', path: 'src/a.js', span: 'L1-L1' }], edges: [] }, cards), /symlink/);
    assert.deepEqual(readdirSync(outside), ['settings.json']);
});

test('trusted temporary-directory aliases work while descendant links stay forbidden', t => {
    const root = fixture(t), actual = join(root, 'actual'), alias = join(root, 'alias');
    mkdirSync(actual);
    symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const url = pathToFileURL(resolve('dist/util/state.js')).href;
    const code = 'import {writeJsonAtomic} from ' + JSON.stringify(url) + '; writeJsonAtomic(' + JSON.stringify(join(alias, 'state.json')) + ',{safe:true});';
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        cwd: root, env: { ...process.env, TEMP: alias, TMP: alias, TMPDIR: alias }, encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(actual, 'state.json'), 'utf8')), { safe: true });
    const outside = join(root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(actual, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
    const blockedCode = 'import {writeJsonAtomic} from ' + JSON.stringify(url) + '; writeJsonAtomic(' + JSON.stringify(join(alias, 'redirect', 'state.json')) + ',{});';
    const blocked = spawnSync(process.execPath, ['--input-type=module', '-e', blockedCode], {
        cwd: root, env: { ...process.env, TEMP: alias, TMP: alias, TMPDIR: alias }, encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    assert.notEqual(blocked.status, 0);
    assert.equal(existsSync(join(outside, 'state.json')), false);
});

test('workspace manifests cannot select a parent, absolute path, or linked sibling', t => {
    const root = fixture(t), repo = join(root, 'repo'), outside = join(root, 'outside');
    mkdirSync(join(repo, '.grafly'), { recursive: true }); mkdirSync(outside);
    symlinkSync(outside, join(repo, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const child of ['../outside', '..\\outside', outside, 'C:\\outside', 'linked']) {
        const ws = { version: 1, children: [child] };
        writeFileSync(join(repo, '.grafly', 'workspace.json'), JSON.stringify(ws));
        assert.equal(readWorkspace(repo), null);
        assert.throws(() => writeWorkspace(repo, ws));
    }
    assert.deepEqual(readdirSync(outside), []);
});

test('brain rules cannot leave instructions behind after retracting their owned block', t => {
    const path = join(fixture(t), 'AGENTS.md');
    writeFileSync(path, 'User-owned instructions\n');
    upsertSection(path, 'first\n<!-- grafly:brain:end -->\nINJECTED\n<!-- graft:start -->', BRAIN_MARKERS);
    removeSection(path, BRAIN_MARKERS);
    assert.equal(readFileSync(path, 'utf8').trim(), 'User-owned instructions');
});

test('hook paths with shell expansion syntax are rejected before commands are emitted', () => {
    for (const path of ['repo/$(touch marker)', 'repo/\x60touch marker\x60', 'repo/"quoted"', 'repo/%COMSPEC%/file', 'repo/a\ncommand'])
        assert.throws(() => quoteHookPath(path), /shell expansion/);
    assert.equal(quoteHookPath('C:\\folder with spaces\\hook.cjs'), '"C:/folder with spaces/hook.cjs"');
});

test('malformed cards and graph shapes do not hide healthy cards or crash retrieval', t => {
    const root = fixture(t);
    writeFileSync(join(root, 'valid.md'), '---\nslug: valid\nname: Valid\n---\nvalid content\n');
    writeFileSync(join(root, 'bad.md'), '---\nname: [broken\n---\n');
    assert.deepEqual(readNodes(root).map(card => card.slug), ['valid']);
    const graph = join(root, 'wiring.json');
    writeFileSync(graph, '{"nodes":{},"edges":[]}');
    assert.equal(readGraph(graph), null);
});

test('sensitive documents are excluded both before extraction and when reading an old cache', t => {
    const root = fixture(t), out = join(root, '.grafly');
    const names = ['readme.md', 'credentials.txt', 'secrets.md', '.env.local'];
    for (const name of names) writeFileSync(join(root, name), 'fixture text');
    assert.deepEqual(listMaterialStats(root, out, names.map(name => join(root, name))).map(file => file.rel), ['readme.md']);
    mkdirSync(join(out, '.graph'), { recursive: true });
    writeFileSync(join(out, '.graph', 'materials.json'), JSON.stringify({ version: 1, files: [
        { path: 'credentials.txt', hash: 'fixture', kind: 'document', status: 'ready', chunks: [] },
    ] }));
    assert.deepEqual(readMaterials(out).files, []);
});

test('tail rejects an oversized file before reading it', t => {
    const root = fixture(t), path = join(root, 'large.log'), fd = openSync(path, 'w');
    try { ftruncateSync(fd, 256 * 1024 * 1024 + 1); } finally { closeSync(fd); }
    assert.throws(() => serveReadCommand('tail', ['-n', '1', 'large.log'], { cwd: root }), /file exceeds/);
});

test('resident requests cannot change executable lookup or runtime selection', () => {
    for (const key of ['PATH', 'PATHEXT', 'MC_ROOT', 'MC_PYTHON', 'GRAFLY_MC_RUNTIME_HOME', 'GRAFLY_MC_PYTHON', 'GRAFLY_NPM_PACKAGE'])
        assert.equal(requestEnv.test(key), false, key);
    for (const key of ['GRAFLY_READONLY', 'GRAFLY_API_KEY', 'GRAFLY_BASE_URL', 'MC_LEARNING_HOME', 'MC_MODEL_HOME', 'MC_MODEL_DISABLED'])
        assert.equal(requestEnv.test(key), true, key);
});

test('output hook backups remain bounded and preserve unrelated backups', t => {
    const root = fixture(t);
    writeFileSync(join(root, 'hooks.json.user.bak'), 'preserve');
    for (let i = 0; i < 9; i++) installOutputHook(root, { remove: i % 2 === 0 });
    assert.equal(readdirSync(root).filter(name => name.startsWith('hooks.json.tool-output-')).length, 5);
    assert.equal(readFileSync(join(root, 'hooks.json.user.bak'), 'utf8'), 'preserve');
});

test('Windows internal commands ignore an executable planted in the checkout', { skip: process.platform !== 'win32' }, t => {
    const root = fixture(t);
    writeFileSync(join(root, 'git.exe'), 'not the trusted Git executable');
    const url = pathToFileURL(resolve('dist/util/subprocess.js')).href;
    const code = 'import {spawnSync} from ' + JSON.stringify(url) + '; const r=spawnSync("git",["--version"],{encoding:"utf8"}); console.log(r.stdout); process.exit(r.status ?? 1);';
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^git version /);
});

test('catastrophic regular expressions are interrupted without hanging the caller', t => {
    const root = fixture(t);
    writeFileSync(join(root, 'sample.js'), 'a'.repeat(1000) + '!');
    const url = pathToFileURL(resolve('dist/search/grep.js')).href;
    const code = 'import assert from "node:assert/strict"; import {grepGraph} from ' + JSON.stringify(url)
        + '; assert.throws(()=>grepGraph({nodes:[{id:"sample.js",kind:"file",path:"sample.js",chars:1001}],edges:[]},process.cwd(),"(a+)+$"),/time budget/);';
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 7000 });
    assert.equal(result.status, 0, result.stderr || String(result.error));
});

test('PDF parsing is terminated even when a parser never yields', t => {
    const root = fixture(t);
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    for (const name of ['pdf.js', 'pdf-worker.js']) copyFileSync(resolve('dist/materials', name), join(root, name));
    const pkg = join(root, 'node_modules/unpdf');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), '{"type":"module","exports":"./index.js"}');
    writeFileSync(join(pkg, 'index.js'), 'export function getDocumentProxy(){while(true){}} export function renderPageAsImage(){}');
    const code = 'import assert from "node:assert/strict"; import {openPdf} from "./pdf.js"; await assert.rejects(openPdf(new Uint8Array([1])),/time budget/);';
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || String(result.error));
});
