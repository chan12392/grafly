import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('tally audit counts Grafly and legacy footers without counting unrelated call text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grafly-tally-'));
    const prompt = { type: 'user', message: { content: 'find a symbol' } };
    const result = (text) => ({ type: 'user', message: { content: [{ type: 'tool_result', content: text }] } });
    const reply = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    const rows = [
        prompt,
        result('[grafly] tokens saved ≈ 1,200'),
        result('[graft] tokens saved ≈ 800'),
        reply('🌱 Grafly saved ~2k tokens this turn (2 calls)'),
        prompt,
        result('[graft] tokens saved ≈ 500'),
        reply('🌱 graft saved ~500 tokens this turn.\n' + 'x'.repeat(80) + ' 9 calls'),
        prompt,
        result('[grafly] tokens saved ≈ 300'),
        reply('Found it.'),
    ];
    writeFileSync(join(dir, 'session.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
    const script = fileURLToPath(new URL('../scripts/tally-audit.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [script, dir, '--json'], { encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.graft_turns, 3);
    assert.equal(report.reported, 2);
    assert.equal(report.silent, 1);
    assert.equal(report.stated_call_count, 1);
    assert.equal(report.median_saved_per_turn, 500);
    assert.deepEqual(report.fidelity, { exact: 2, over: 0, under: 0 });
});
