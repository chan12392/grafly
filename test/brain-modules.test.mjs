import test from 'node:test';
import assert from 'node:assert/strict';
import { mineRules } from '../service/brain-mining.mjs';

const digest = { owner: 'o', name: 'r', default_branch: 'main', commits: [], threads: [], symbols: [{ id: 's', kind: 'function', name: 'work', path: 'work.js', fingerprint: 'trusted' }] };
const llm = { url: 'https://llm.invalid/v1', key: 'test-only', model: 'model' };

test('mining keeps request, validation, deterministic IDs, source and cap contracts', async t => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    let request;
    globalThis.fetch = async (url, options) => {
        request = { url, options };
        return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify({ anchors: [
            { symbol: 'unknown', rule: 'ignore' }, { symbol: 's', rule: ' keep ', source: '#42', fingerprint: 'untrusted' },
            { symbol: 's', rule: 'keep', source: 'abcdef' }, { symbol: 's', rule: 'second', source: 'abcdef' },
            ...Array.from({ length: 70 }, (_, i) => ({ symbol: 's', rule: `rule ${i}`, source: 'invalid source' })),
        ] }) + '\n```' } }] }) };
    };
    const rules = await mineRules(digest, llm);
    assert.equal(rules.length, 60);
    assert.equal(request.url, 'https://llm.invalid/v1/chat/completions');
    assert.equal(request.options.headers.authorization, 'Bearer test-only');
    assert.ok(request.options.signal instanceof AbortSignal);
    const payload = JSON.parse(request.options.body);
    assert.equal(payload.model, 'model');
    assert.equal(payload.temperature, 0.2);
    assert.match(payload.messages[1].content, /s function work \(work.js\)/);
    assert.equal(rules[0].rule, 'keep');
    assert.equal(rules[0].fingerprint, 'trusted');
    assert.equal(rules[0].source_url, 'https://github.com/o/r/pull/42');
    assert.equal(rules[1].source_url, 'https://github.com/o/r/commit/abcdef');
    assert.equal(rules[2].source_url, undefined);
    assert.match(rules[0].rule_id, /^m_[0-9a-f]{16}$/);
    assert.deepEqual(await mineRules(digest, llm), rules);
});

test('mining retains HTTP failure, malformed response and empty anchor behavior', async t => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => 'x'.repeat(400) });
    await assert.rejects(mineRules(digest, llm), error => error.message === 'LLM 503: ' + 'x'.repeat(300));
    globalThis.fetch = async () => ({ ok: true, text: async () => '{broken' });
    await assert.rejects(mineRules(digest, llm), SyntaxError);
    for (const invalid of [{}, { anchors: null }, { anchors: {} }, { anchors: [null] },
        { anchors: [{ symbol: 's', rule: 1 }] }, { anchors: [{ symbol: 's', rule: ' ' }] }]) {
        globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(invalid) } }] }) });
        await assert.rejects(mineRules(digest, llm), /Invalid mining response/);
    }
    globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '{"anchors":[]}' } }] }) });
    assert.deepEqual(await mineRules(digest, llm), []);
});
