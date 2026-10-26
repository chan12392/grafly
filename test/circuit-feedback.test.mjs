import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendCircuitRecord, isExplicitLabel, recordLabel } from '../dist/circuit/feedback.js';
import { logCircuit } from '../dist/graph/traverse-cli.js';
import { contextDirFor } from '../dist/context/node-file.js';

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'grafly-label-'));
    mkdirSync(contextDirFor(root));
    const log = join(contextDirFor(root), 'circuit-log.jsonl');
    const judgment = { type: 'judge', ts: new Date().toISOString(), root, query: 'run',
        verdict: 'confident', top1: 'a.js#run', scores: [{ id: 'a.js#run', score: 2 }, { id: 'b.js#run', score: 1 }] };
    const jid = logCircuit(log, judgment);
    return { root, log, jid, judgment };
}

test('explicit reviews require a retained same-repository judgment, candidate and evidence', () => {
    const f = fixture(), original = readFileSync(f.log, 'utf8');
    assert.throws(() => recordLabel(f.log, f.root, f.jid, 'a.js#run', '  '), /evidence/);
    assert.throws(() => recordLabel(f.log, f.root, f.jid, 'unknown', 'checked'), /candidate/);
    assert.throws(() => recordLabel(f.log, f.root, 'missing', 'a.js#run', 'checked'), /unknown judgment/);
    assert.throws(() => recordLabel(f.log, tmpdir(), f.jid, 'a.js#run', 'checked'), /unknown judgment/);
    assert.throws(() => recordLabel(null, f.root, f.jid, 'abstain', 'checked'), /disabled/);
    assert.equal(readFileSync(f.log, 'utf8'), original);
    const label = recordLabel(f.log, f.root, f.jid, 'b.js#run', '  Checked the import in client.js:12  ');
    assert.equal(label.evidence, 'Checked the import in client.js:12');
    assert.ok(isExplicitLabel(label, f.judgment));
    assert.equal(isExplicitLabel({ ...label, evidence: '' }, f.judgment), false);
    assert.equal(isExplicitLabel(label, { ...f.judgment, scores: {} }), false);
    assert.equal(isExplicitLabel({ ...label, expected: 'abstain' }, { ...f.judgment, scores: [null] }), false);
    assert.equal(isExplicitLabel({ ...label, ts: { toString: null, valueOf: null } }, f.judgment), false);
    if (process.platform === 'win32') assert.ok(isExplicitLabel({ ...label, root: label.root.toUpperCase() }, f.judgment));
    assert.ok(readFileSync(f.log, 'utf8').startsWith(original));
});

test('rotated judgments can be reviewed and malformed log entries do not become labels', () => {
    const f = fixture();
    renameSync(f.log, f.log + '.1');
    writeFileSync(f.log, 'null\nnot-json\n');
    assert.equal(recordLabel(f.log, f.root, f.jid, 'abstain', 'No unique target is supported').expected, 'abstain');
});

test('installed CLI writes explicit reviews and analyzer uses only the latest checked label', () => {
    const f = fixture(), cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const env = { ...process.env, GRAFLY_CIRCUIT_LOG: '', DO_NOT_TRACK: '1' };
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000, env });
    const first = run('feedback', f.jid, 'b.js#run', f.root, '--evidence', 'Confirmed the task targets b.js');
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).expected, 'b.js#run');
    const second = run('feedback', f.jid, 'a.js#run', f.root, '--evidence', 'Correction: verified the actual import targets a.js');
    assert.equal(second.status, 0, second.stderr);
    appendCircuitRecord(f.log, { type: 'adopt', jid: f.jid });
    appendCircuitRecord(f.log, { ...JSON.parse(second.stdout), jid: 'unknown' });
    appendCircuitRecord(f.log, { ...JSON.parse(second.stdout), ts: { toString: null, valueOf: null } });
    const analyzer = fileURLToPath(new URL('../scripts/circuit-log-analyze.mjs', import.meta.url));
    const report = spawnSync(process.execPath, [analyzer, '--dir', f.root], { encoding: 'utf8', windowsHide: true });
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /explicit reviews: 1 .*invalid\/unmatched labels: 2/);
    assert.match(report.stdout, /reviewed verdict agreement: 1\/1/);
    assert.match(report.stdout, /legacy adopt=1 reject=0 \(not correctness labels\)/);
    const missing = run('feedback', f.jid, 'a.js#run', f.root);
    assert.notEqual(missing.status, 0);
});

test('callers exposes a saved judgment ID that the feedback CLI can review', () => {
    const root = mkdtempSync(join(tmpdir(), 'grafly-review-cli-'));
    for (const name of ['a', 'b']) writeFileSync(join(root, name + '.js'), 'export function helper(){return 1;}\n');
    const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8',
        windowsHide: true, timeout: 30000, env: { ...process.env, GRAFLY_CIRCUIT_LOG: '', DO_NOT_TRACK: '1' } });
    const built = run('build');
    assert.equal(built.status, 0, built.stderr);
    const callers = run('callers', 'helper', '--json', '--no-refresh');
    assert.equal(callers.status, 0, callers.stderr);
    const { circuit } = JSON.parse(callers.stdout);
    assert.match(circuit.jid, /^[a-f0-9]{12}$/);
    const review = run('feedback', circuit.jid, 'abstain', '--evidence', 'Both fixture definitions have equivalent evidence');
    assert.equal(review.status, 0, review.stderr);
    const analyzer = fileURLToPath(new URL('../scripts/circuit-log-analyze.mjs', import.meta.url));
    const report = spawnSync(process.execPath, [analyzer, '--dir', root], { encoding: 'utf8', windowsHide: true });
    assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /reviewed verdict agreement: 1\/1/);
    assert.match(report.stdout, /reviewed top-1 target matches: 0\/0/);
});
