import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { writeGraph } from '../dist/graph/write.js';
import { writeLink, writeRulesCache } from '../dist/brain/link.js';
import { rulesForPointers } from '../dist/brain/attach.js';
import { renderBrainSection } from '../dist/brain/wire.js';
import { readPath, serveReadCommand } from '../dist/tool-output/output.js';
import { runCommand } from '../dist/tool-output/runner.js';

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'grafly-boundary-audit-'));
    t.after(() => {
        assert.equal(dirname(resolve(root)), resolve(tmpdir()));
        assert.ok(root.includes('grafly-boundary-audit-'));
        rmSync(root, { recursive: true, force: true });
    });
    return root;
}
const rule = (i, symbol = `file.js#fn${i}`) => ({ ruleId: `r${i}`, symbol, rule: `Rule ${i}`, fingerprint: 'current' });
function isolatedEnv(root) {
    return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GRAFLY|GRAFT|MC)_/i.test(key))),
        HOME: root, USERPROFILE: root, GRAFLY_NO_DAEMON: '1', GRAFLY_JUDGMENT_CONFIG: '0',
        MC_LEARNING_HOME: join(root, 'learning'), MC_MODEL_HOME: join(root, 'models') };
}

test('brain status counts every anchored rule and late stale rules without changing answer caps', t => {
    const root = fixture(t);
    const graph = { meta: {}, nodes: Array.from({ length: 8 }, (_, i) => ({
        id: `file.js#fn${i}`, name: `fn${i}`, kind: 'function', path: 'file.js', span: `L${i + 1}-L${i + 1}`, body_hash: 'current',
    })), edges: [] };
    writeGraph(graph, join(root, '.grafly'));
    const rules = Array.from({ length: 8 }, (_, i) => rule(i));
    rules[1].rule = rules[0].rule;
    rules[7].fingerprint = 'old';
    rules.push(rule(8, ''), rule(9, 'deleted.js#fn9'));
    const link = { brainId: 'local-test', token: 'local-only', local: true };
    writeLink(root, link);
    writeRulesCache(root, { brainId: link.brainId, fetchedAt: 1, rules }, link);
    const cli = fileURLToPath(new URL('../dist/entry.js', import.meta.url));
    const run = args => {
        const result = spawnSync(process.execPath, [cli, 'brain', 'status', root, ...args], {
            cwd: root, env: isolatedEnv(root), encoding: 'utf8', windowsHide: true, timeout: 20000,
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        return result;
    };
    const status = JSON.parse(run(['--json']).stdout);
    assert.equal(status.cached, 10);
    assert.equal(status.anchored, 8);
    assert.equal(status.stale, 1);
    const text = run([]).stderr;
    assert.match(text, /8 anchored to symbols/);
    assert.match(text, /1 describe code that has changed/);
    assert.match(text, /Rule 7/);
    const attached = rulesForPointers(graph.nodes.map(n => `${n.path}:${n.span}`), rules, graph);
    assert.equal(attached.length, 6);
    assert.equal(new Set(attached.map(r => r.rule)).size, attached.length);
});

test('instruction sections prioritize repo-wide rules and describe omitted rule types accurately', () => {
    const anchored = Array.from({ length: 40 }, (_, i) => rule(i));
    const section = renderBrainSection([...anchored, rule('general', '')], 'fixture');
    assert.match(section, /Rule general/);
    assert.equal(section.split('\n').filter(line => line.startsWith('- ')).length, 40);
    assert.ok(section.indexOf('Rule general') < section.indexOf('### file.js'));
    assert.match(section, /1 more rules apply to specific symbols/);
    const overflow = renderBrainSection([...Array.from({ length: 41 }, (_, i) => rule(`general${i}`, '')), rule('anchored')], 'fixture');
    assert.equal(overflow.split('\n').filter(line => line.startsWith('- ')).length, 40);
    assert.match(overflow, /1 repo-wide rule/);
    assert.match(overflow, /1 more rules apply to specific symbols/);
});

test('shell read substitution leaves directories to the original command', t => {
    const root = fixture(t);
    mkdirSync(join(root, 'folder'));
    writeFileSync(join(root, 'folder', 'child.txt'), 'child');
    for (const command of ['cat', 'type', 'more', 'Get-Content', 'gc', 'head', 'tail'])
        assert.equal(serveReadCommand(command, ['folder'], { cwd: root }), null, command);
    assert.match(readPath(join(root, 'folder')), /child\.txt/);
});

test('routed cat preserves the actual directory error and exit code', async t => {
    const root = fixture(t), command = process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/cat.exe' : 'cat';
    if (process.platform === 'win32' && !existsSync(command)) return t.skip('Git cat executable is not installed');
    mkdirSync(join(root, 'folder'));
    const env = { ...isolatedEnv(root), GRAFLY_TOOL_OUTPUT: '1' };
    const direct = spawnSync(command, ['folder'], { cwd: root, env, encoding: 'utf8', windowsHide: true });
    assert.ifError(direct.error);
    assert.equal(direct.status, 1);
    let stdout = '', stderr = '';
    const result = await runCommand(command, ['folder'], { cwd: root, env, archiveDir: join(root, 'archive'),
        stdout: { write: chunk => { stdout += chunk.toString(); } }, stderr: { write: chunk => { stderr += chunk.toString(); } } });
    assert.equal(result.exit_code, direct.status);
    assert.equal(stdout, direct.stdout);
    assert.equal(stderr, direct.stderr);
    assert.notEqual(result.served, 'read-path');
});
