import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { FILES_V5, sha256, syncRuntime, acquireLock, smokeTest, pinRuntime } from '../dist/mc-runtime/runtime.js';
import { MODEL_TASKS, modelHome, modelStatus, syncModels, verifyModelEnvelope } from '../dist/mc-runtime/models.js';
import { runLearning, syncUpdates } from '../dist/mc-runtime/cli.js';
import { symbolModel, contextModel } from './fixtures/mc-model.mjs';

async function fixture(t, real = false) {
  const root = mkdtempSync(join(tmpdir(), 'grafly-model-delivery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = join(root, 'runtime'), home = join(root, 'consumer');
  mkdirSync(runtime); mkdirSync(home);
  const keys = generateKeyPairSync('ed25519');
  const config = { url: 'https://release.invalid/mc', token: 'r'.repeat(64), python: real ? process.env.GRAFLY_TEST_PYTHON : process.execPath,
    minimumVersion: '0.1.0', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) };
  writeFileSync(join(runtime, 'config.json'), JSON.stringify(config));
  const envelope = metadata => {
    const bytes = Buffer.from(JSON.stringify(metadata));
    return { payload: bytes.toString('base64'), signature: sign(null, bytes, keys.privateKey).toString('base64') };
  };
  const channels = Object.fromEntries(['tool_output', 'symbol_disambiguation', 'patch_quality', 'context_judgment']
    .map(id => [id, { version: '0.1.0', tag: `channel/${id}/v0.1.0` }]));
  const file = Buffer.from('# signed transport fixture\n');
  let code = { schema: 'mc.runtime.bundle.v1', version: '0.5.0', source: 'a'.repeat(40), runtime_api: 5, python_min: '3.11',
    channels, provided_channels: Object.keys(channels), files: Object.fromEntries(FILES_V5.map(name => [name, { data: file.toString('base64'), sha256: sha256(file) }])) };
  if (real) {
    const script = "import json,sys;from pathlib import Path;sys.path[:0]=[sys.argv[1],str(Path(sys.argv[1])/'scripts')];from morecoffee import __version__;from build_channel_release import build;print(json.dumps(build(__version__,False)))";
    const child = spawnSync(config.python, ['-I', '-S', '-B', '-X', 'utf8', '-c', script, process.env.GRAFLY_TEST_MC_SOURCE],
      { encoding: 'utf8', timeout: 10000, windowsHide: true, maxBuffer: 512 * 1024 });
    assert.equal(child.status, 0, child.stderr); code = JSON.parse(child.stdout);
    assert.equal(code.runtime_api, 5);
  }
  const codeBytes = Buffer.from(JSON.stringify(code));
  const codeMeta = { schema: 'mc.runtime.release.v1', version: code.version, source: code.source, runtime_api: 5, python_min: '3.11',
    channels: code.channels, provided_channels: code.provided_channels, sequence: 1, sha256: sha256(codeBytes), bytes: codeBytes.length };
  await syncRuntime(runtime, { transport: async url => new Response(url.endsWith('/stable') ? JSON.stringify(envelope(codeMeta)) : codeBytes), smoke: real ? smokeTest : () => {} });
  const release = (sequence = 1, mutate = () => {}) => {
    const models = Object.fromEntries(MODEL_TASKS.map(task => {
      if (!['symbol_disambiguation', 'patch_quality'].includes(task)) return [task, null];
      // Transport fixtures bypass only MC's semantic validator; never install them outside this temporary cache.
      const data = Buffer.from(JSON.stringify({ task, dataset_sha256: sha256(task + sequence), fixture: sequence }));
      return [task, { sha256: sha256(data), content: data.toString('base64') }];
    }));
    const bundle = { schema: 'mc.model.bundle.v1', runtime_api_min: 5, model_schema: 'mc.learned.v1',
      policy: 'mc.grouped-fresh-audit.v1', scorer_version: 'mc.context-judgment.v1', source_runtime_sha256: codeMeta.sha256,
      models, revoked_model_sha256: [] };
    mutate(bundle);
    const bytes = Buffer.from(JSON.stringify(bundle));
    const metadata = { ...bundle, schema: 'mc.model.release.v1', sequence, sha256: sha256(bytes), bytes: bytes.length,
      published_at: '2026-10-23T00:00:00Z', models: Object.fromEntries(MODEL_TASKS.map(task => {
        const entry = bundle.models[task];
        return [task, entry && { model_sha256: entry.sha256, dataset_sha256: JSON.parse(Buffer.from(entry.content, 'base64')).dataset_sha256 }];
      })) };
    return { bytes, bundle, metadata, envelope: envelope(metadata) };
  };
  const transport = r => async (url, options) => {
    assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer ' + config.token);
    return new Response(url.endsWith('/v1/models/stable') ? JSON.stringify(r.envelope) : r.bytes);
  };
  const install = (r, options = {}) => syncModels(runtime, { home, transport: transport(r), validate() {}, ...options });
  return { root, runtime, home, config, release, transport, install, envelope, keys, codeBytes, codeMeta };
}

test('signed MC validates context v1/v2 models, prepared inputs and 0/9/73 parameter counts', {
  skip: !process.env.GRAFLY_TEST_MC_SOURCE || !process.env.GRAFLY_TEST_PYTHON,
}, async t => {
  const f = await fixture(t, true), pinned = pinRuntime({ GRAFLY_MC_RUNTIME_HOME: f.runtime });
  const learning = join(f.root, 'disabled-learning');
  const invoke = (operation, payload) => {
    const child = spawnSync(pinned.python, ['-I', '-S', '-B', '-X', 'utf8', '-c',
      "import sys,runpy;sys.path.insert(0,sys.argv[1]);runpy.run_module('morecoffee.channels.channel_host',run_name='__main__')", pinned.root],
    { input: JSON.stringify({ schema_version: 'mc.channel.v1', channel_id: 'context_judgment', request_id: 'consumer-check', operation, payload }) + '\n',
      encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...process.env, MC_MODEL_HOME: f.home, MC_LEARNING_HOME: learning } });
    assert.equal(child.status, 0, child.stderr);
    const response = JSON.parse(child.stdout); assert.equal(response.status, 'ok', child.stdout); return response;
  };
  const payload = { source: 'grafly', task: 'document_suitability', group_id: 'a'.repeat(64), case_origin: 'synthetic',
    goal: 'Retain the instruction and its definition.', constraints: ['Keep source facts.'], items: [
      { id: 'instruction', text: 'Use the definition.', protected: false, constraint_status: 'unknown', role: 'instruction', requires: ['definition'] },
      { id: 'definition', text: 'A supplied definition.', protected: false, constraint_status: 'unknown', role: 'definition' },
    ] };
  const preparation = invoke('prepare', payload);
  assert.equal(preparation.learned_parameter_count, 0);
  const prepared = preparation.decision.prepared_payload;
  assert.deepEqual(prepared, { ...payload, items: payload.items.map(item => ({ ...item, protected: true })) });
  assert.equal(invoke('judge', prepared).learned_parameter_count, 0);
  let sequence = 0;
  const release = (model, mutate = () => {}) => f.release(++sequence, bundle => {
    const bytes = Buffer.from(JSON.stringify(model));
    bundle.models = Object.fromEntries(MODEL_TASKS.map(task => [task, task === model.task
      ? { sha256: sha256(bytes), content: bytes.toString('base64') } : null]));
    mutate(bundle);
  });
  const install = r => syncModels(f.runtime, { home: f.home, transport: f.transport(r) });
  for (const [version, count] of [['mc.context-judgment.v1', 9], ['mc.context-judgment.v2', 73]]) {
    const r = release(contextModel(version));
    assert.equal(r.bundle.scorer_version, 'mc.context-judgment.v1');
    assert.equal((await install(r)).status, 'updated');
    const judged = invoke('judge', prepared);
    assert.equal(judged.learned_parameter_count, count);
    assert.equal(judged.decision.input_sha256, preparation.decision.input_sha256);
    assert.equal(judged.decision.model_sha256, r.metadata.models.document_suitability.model_sha256);
    assert.ok(judged.decision.judgments.every(row => row.feedback.schema === 'mc.feedback.v2'
      && Object.keys(row.feedback.features).length === 8 && row.feedback.input_sha256 === preparation.decision.input_sha256));
  }
  const before = readFileSync(join(f.home, 'current.json'));
  for (const mutate of [
    model => { model.scorer_version = 'mc.context-judgment.future'; },
    model => { delete model.weights.ordered_63; },
    model => { model.weights.ordered_64 = 0; },
    model => { delete model.fit.class_weight; },
    model => { model.fit.class_weight = 'unbalanced'; },
  ]) {
    const model = contextModel(); mutate(model);
    await assert.rejects(install(release(model)));
    assert.deepEqual(readFileSync(join(f.home, 'current.json')), before);
  }
  await assert.rejects(install(release(contextModel(), bundle => { bundle.scorer_version = 'mc.context-judgment.v2'; })), /mc_model_incompatible/);
  assert.deepEqual(readFileSync(join(f.home, 'current.json')), before);
  assert.equal(existsSync(join(learning, 'feedback.sqlite3')), false);
});

test('separate signed model cache activates atomically, reports model/data hashes and remains usable offline', async t => {
  const f = await fixture(t), a = f.release();
  assert.equal((await f.install(a)).status, 'updated');
  assert.equal((await f.install(a)).status, 'current');
  const before = readFileSync(join(f.home, 'current.json'));
  const status = modelStatus(f.runtime, f.home);
  assert.equal(status.status, 'ok'); assert.deepEqual(status.models, a.metadata.models);
  assert.ok(!JSON.stringify(status).includes(f.config.token));
  await assert.rejects(f.install(a, { transport: async () => { throw new Error('offline secret'); } }));
  assert.deepEqual(readFileSync(join(f.home, 'current.json')), before);
  assert.deepEqual(modelStatus(f.runtime, f.home).models, a.metadata.models);
  assert.equal(JSON.parse(readFileSync(join(f.home, 'status.json'))).reason, 'mc_model_update_failed');
  assert.equal(existsSync(join(f.home, 'active.json')), false);
  assert.equal(existsSync(join(f.home, 'config.json')), false);
});

test('bad signatures, hashes, validator failures and replays preserve the last valid pointer', async t => {
  const f = await fixture(t), a = f.release(2);
  await f.install(a);
  const before = readFileSync(join(f.home, 'current.json'));
  const bad = f.release(3); bad.envelope.signature = Buffer.alloc(64).toString('base64');
  await assert.rejects(f.install(bad), /mc_model_signature/);
  const corrupt = f.release(3); corrupt.bytes[0] ^= 1;
  await assert.rejects(f.install(corrupt), /mc_model_bundle_hash/);
  await assert.rejects(f.install(f.release(1)), /mc_model_downgrade/);
  await assert.rejects(f.install(f.release(3, b => { b.source_runtime_sha256 = 'f'.repeat(64); })), /mc_model_downgrade/);
  await assert.rejects(f.install(f.release(4), { validate() { throw new Error('invalid evaluation gate'); } }));
  assert.deepEqual(readFileSync(join(f.home, 'current.json')), before);
  assert.deepEqual(modelStatus(f.runtime, f.home).models, a.metadata.models);
  assert.equal((await f.install(f.release(4))).status, 'updated');
});

test('newer signed revocations stop the incumbent even when the replacement is unavailable or incompatible', async t => {
  const f = await fixture(t), a = f.release();
  await f.install(a);
  const revoked = a.metadata.models.symbol_disambiguation.model_sha256;
  const replacement = f.release(2, b => {
    b.revoked_model_sha256 = [revoked]; b.models.symbol_disambiguation = null;
    b.models.patch_quality = a.bundle.models.patch_quality;
  });
  const before = readFileSync(join(f.home, 'current.json'));
  await assert.rejects(f.install(replacement, { transport: async url => {
    if (url.endsWith('/stable')) return new Response(JSON.stringify(replacement.envelope));
    throw new Error('offline');
  } }));
  assert.deepEqual(readFileSync(join(f.home, 'current.json')), before);
  assert.equal(modelStatus(f.runtime, f.home).models.symbol_disambiguation, null);
  assert.deepEqual(modelStatus(f.runtime, f.home).models.patch_quality, a.metadata.models.patch_quality);
  await assert.rejects(f.install(a), /mc_model_downgrade/);
  await assert.rejects(f.install(f.release(3)), /mc_model_downgrade/);
  const future = f.release(3, b => { b.runtime_api_min = 6; b.revoked_model_sha256 = [revoked]; });
  await assert.rejects(f.install(future), /mc_model_incompatible/);
  assert.equal(modelStatus(f.runtime, f.home).models.symbol_disambiguation, null);
  assert.equal(modelStatus(f.runtime, f.home).revocation_sequence, 3);
});

test('unrevoked removal, malformed task maps and oversized model bytes fail closed', async t => {
  const f = await fixture(t), a = f.release();
  await f.install(a);
  await assert.rejects(f.install(f.release(2, b => { b.models.patch_quality = null; })), /mc_model_unrevoked_removal/);
  const malformed = { ...a.metadata, models: {} };
  assert.throws(() => verifyModelEnvelope(f.envelope(malformed), f.config), /mc_model_release_contract/);
  const huge = f.release(3, b => {
    const bytes = Buffer.from(JSON.stringify({ task: 'symbol_disambiguation', dataset_sha256: 'a'.repeat(64), padding: 'x'.repeat(17000) }));
    b.models.symbol_disambiguation = { sha256: sha256(bytes), content: bytes.toString('base64') };
  });
  await assert.rejects(f.install(huge), /mc_model_encoding/);
  assert.deepEqual(modelStatus(f.runtime, f.home).models, a.metadata.models);
});

test('large cumulative revocations fit the separate manifest/envelope bounds and remain replay-safe', async t => {
  const f = await fixture(t);
  const large = f.release(1, b => { b.revoked_model_sha256 = Array.from({ length: 1900 }, (_, i) => sha256('revoked-' + i)); });
  assert.ok(large.bytes.length < 128 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(large.envelope)) > 128 * 1024);
  assert.equal((await f.install(large)).status, 'updated');
  assert.equal((await f.install(large)).status, 'current');
  assert.equal(modelStatus(f.runtime, f.home).status, 'ok');
  await assert.rejects(f.install(large, { transport: async () => new Response('x'.repeat(384 * 1024 + 1)) }), /mc_download_size/);
  assert.equal(modelStatus(f.runtime, f.home).sequence, 1);
  assert.throws(() => verifyModelEnvelope({ payload: Buffer.alloc(256 * 1024 + 1).toString('base64') }, f.config), /mc_model_encoding/);
});

test('one updater owns the cache, symlinks fail closed, and training home cannot be selected', async t => {
  const f = await fixture(t), a = f.release();
  const unlock = acquireLock(f.home);
  assert.equal((await f.install(a)).status, 'busy'); unlock();
  await f.install(a);
  const linked = join(f.root, 'linked');
  symlinkSync(f.home, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(syncModels(f.runtime, { home: linked }), /mc_model_directory/);
  assert.throws(() => modelHome({ MC_MODEL_HOME: f.home, MC_LEARNING_HOME: f.home }), /mc_model_home/);
  if (process.platform === 'win32') assert.throws(() => modelHome({ MC_MODEL_HOME: f.home.toUpperCase(), MC_LEARNING_HOME: f.home }), /mc_model_home/);
  assert.throws(() => modelHome({ MC_MODEL_HOME: 'relative' }), /mc_model_home/);
  writeFileSync(join(f.home, 'models', a.metadata.models.symbol_disambiguation.model_sha256 + '.json'), 'tampered');
  assert.equal(modelStatus(f.runtime, f.home).status, 'error');
});

test('code failure still polls models, a missing release is waiting, and consumer commands cannot train', async t => {
  const f = await fixture(t), paths = [];
  const result = await syncUpdates(f.runtime, { modelsHome: f.home, transport: async url => {
    paths.push(url);
    if (url.endsWith('/v1/models/stable')) return new Response('no_model_release', { status: 404 });
    throw new Error('code offline');
  } });
  assert.equal(result.status, 'retrying'); assert.equal(result.models.status, 'waiting');
  assert.ok(paths.some(p => p.endsWith('/v1/models/stable')));
  assert.equal(existsSync(join(f.runtime, 'learning-watch-status.json')), false);
  await assert.rejects(runLearning('cycle', f.runtime), /mc_learning_mc_owned/);
  await assert.rejects(runLearning('configure', f.runtime), /mc_learning_mc_owned/);
});

test('actual signed API5 and MC publisher deliver and revoke a model over HTTP without enabling learning',
  { skip: !process.env.GRAFLY_TEST_MC_SOURCE || !process.env.GRAFLY_TEST_PYTHON }, async t => {
  const f = await fixture(t, true), dataDir = join(f.root, 'publisher'), learning = join(f.root, 'learning');
  for (const dir of ['bundles', 'releases']) mkdirSync(join(dataDir, dir), { recursive: true });
  mkdirSync(learning);
  writeFileSync(join(learning, 'config.json'), JSON.stringify({ schema: 'mc.learning.config.v1', enabled: false }));
  writeFileSync(join(dataDir, 'bundles', f.codeMeta.sha256 + '.json'), f.codeBytes);
  writeFileSync(join(dataDir, 'releases', f.codeMeta.version + '.json'), JSON.stringify(f.envelope(f.codeMeta)));
  writeFileSync(join(dataDir, 'stable.json'), JSON.stringify(f.envelope(f.codeMeta)));
  const { createWebhookServer } = await import(pathToFileURL(join(process.env.GRAFLY_TEST_MC_SOURCE, 'service/releases/webhook-server.mjs')).href);
  const writer = 'publisher-fixture-' + 's'.repeat(32);
  const server = createWebhookServer({ dataDir, privateKey: f.keys.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    readTokenHashes: [sha256(f.config.token)], modelPublishTokenHash: sha256(writer), webhookSecret: 's'.repeat(32) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const transport = (url, options) => fetch(url.replace(f.config.url, endpoint), options);
  assert.equal((await syncModels(f.runtime, { home: f.home, transport })).status, 'waiting');
  const modelBytes = Buffer.from(JSON.stringify(symbolModel(0.1))), digest = sha256(modelBytes);
  const bundle = { schema: 'mc.model.bundle.v1', runtime_api_min: 5, model_schema: 'mc.learned.v1', policy: 'mc.grouped-fresh-audit.v1',
    scorer_version: 'mc.context-judgment.v1', source_runtime_sha256: f.codeMeta.sha256, revoked_model_sha256: [],
    models: Object.fromEntries(MODEL_TASKS.map(task => [task, task === 'symbol_disambiguation' ? { sha256: digest, content: modelBytes.toString('base64') } : null])) };
  const publish = (token, expected_sequence) => fetch(endpoint + '/v1/models/publish', { method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ schema: 'mc.model.publish.v1', expected_sequence, bundle: Buffer.from(JSON.stringify(bundle)).toString('base64') }) });
  assert.equal((await publish(f.config.token, 0)).status, 401);
  const published = await publish(writer, 0);
  assert.equal(published.status, 200, await published.clone().text());
  const first = await published.json();
  assert.equal((await syncModels(f.runtime, { home: f.home, transport })).status, 'updated');
  assert.equal(modelStatus(f.runtime, f.home).models.symbol_disambiguation.model_sha256, digest);
  const consumer = () => {
    const uri = new URL('../dist/circuit/judge.js', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {judgeSymbols} from ${JSON.stringify(uri)}; console.log(JSON.stringify(judgeSymbols({edges:[]},'probe',[])));`],
      { encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, GRAFLY_MC_RUNTIME_HOME: f.runtime,
        MC_ROOT: '', GRAFLY_WEIGHTS: '', MC_MODEL_HOME: f.home, MC_LEARNING_HOME: learning } });
    assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
  };
  assert.equal(consumer().model_sha256, digest);
  const offlineCode = await syncUpdates(f.runtime, { modelsHome: f.home, transport: (url, options) => {
    if (url.endsWith('/v1/stable')) throw new Error('offline code');
    return transport(url, options);
  } });
  assert.equal(offlineCode.status, 'retrying'); assert.equal(offlineCode.models.status, 'current');
  bundle.models.symbol_disambiguation = null; bundle.revoked_model_sha256 = [digest];
  const revoked = await publish(writer, 1); assert.equal(revoked.status, 200, await revoked.clone().text());
  await assert.rejects(syncModels(f.runtime, { home: f.home, transport: (url, options) => {
    if (url.includes('/v1/models/bundles/')) throw new Error('interrupted replacement');
    return transport(url, options);
  } }));
  assert.equal(consumer().model_sha256, null);
  await assert.rejects(syncModels(f.runtime, { home: f.home, transport: async () => new Response(JSON.stringify(first)) }), /mc_model_downgrade/);
  assert.equal((await syncModels(f.runtime, { home: f.home, transport })).status, 'updated');
  assert.equal(existsSync(join(learning, 'feedback.sqlite3')), false);
  assert.equal(existsSync(join(learning, 'active.json')), false);
});
