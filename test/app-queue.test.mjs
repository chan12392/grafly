import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { WorkQueue } from '../dist/app/queue.js';

test('same-PR jobs wait, supersede pending work, and drain only after every worker finishes', async () => {
    const started = [], published = [], finishes = new Map();
    let active = 0, maximum = 0;
    const queue = new WorkQueue(async job => {
        started.push(job); active++; maximum = Math.max(maximum, active);
        await new Promise(resolve => finishes.set(job, resolve));
        published.push(job); active--;
    }, { concurrency: 2 });
    queue.push('one', 'old');
    queue.push('one', 'superseded');
    queue.push('one', 'latest');
    queue.push('two', 'other');
    assert.deepEqual(started, ['old', 'other']);
    assert.equal(queue.size, 3);
    let drained = false;
    const drain = queue.drain().then(() => { drained = true; });
    finishes.get('other')(); await nextTurn();
    assert.equal(drained, false);
    assert.deepEqual(started, ['old', 'other']);
    finishes.get('old')(); await nextTurn();
    assert.deepEqual(started, ['old', 'other', 'latest']);
    assert.equal(drained, false);
    finishes.get('latest')(); await drain;
    assert.equal(maximum, 2);
    assert.equal(active, 0);
    assert.equal(queue.size, 0);
    assert.deepEqual(published, ['other', 'old', 'latest']);
});
