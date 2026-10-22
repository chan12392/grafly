import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FILES, FILES_V2, sha256, syncRuntime, resolveRuntime, pinRuntime, validatePinned } from '../dist/mc-runtime/runtime.js';
import { executeCliRequest } from '../dist/search/cli-request.js';

const python = process.env.GRAFLY_TEST_PYTHON;
const source = process.env.GRAFLY_TEST_MC_SOURCE;
const real = { skip: !python || !source };
const keys = generateKeyPairSync('ed25519');
let original;
function packageFixture() {
  if (!original) {
    const code = "import json,sys;from pathlib import Path;sys.path[:0]=[sys.argv[1],str(Path(sys.argv[1])/'scripts')];from morecoffee import __version__;from build_channel_release import build;print(json.dumps(build(__version__,False)))";
    const child = spawnSync(python, ['-I', '-S', '-B', '-X', 'utf8', '-c', code, resolve(source)],
      { encoding: 'utf8', timeout: 10000, windowsHide: true, maxBuffer: 512 * 1024 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    original = JSON.parse(child.stdout);
  }
  return structuredClone(original);
}
function edit(bundle, path, change) {
  const text = Buffer.from(bundle.files[path].data, 'base64').toString('utf8');
  const next = change(text);
  assert.notEqual(next, text, `fixture edit must change ${path}`);
  const bytes = Buffer.from(next);
  bundle.files[path] = { data: bytes.toString('base64'), sha256: sha256(bytes) };
}
function future(version, runtime = '0.3.3') {
  const bundle = packageFixture(); bundle.version = runtime;
  for (const id of ['symbol_disambiguation', 'patch_quality']) {
    const previous = bundle.channels[id].version;
    edit(bundle, 'morecoffee/channels/builtin/catalog.py', text =>
      text.replace(`channel_id="${id}", version="${previous}"`, `channel_id="${id}", version="${version}"`));
    bundle.channels[id] = { version, tag: `channel/${id}/v${version}` };
  }
  edit(bundle, 'morecoffee/channels/portable/symbol_disambiguation.json', text => {
    const artifact = JSON.parse(text); artifact.channel_version = version; return JSON.stringify(artifact);
  });
  return bundle;
}
function signed(bundle, sequence = 6, change = () => {}) {
  const bytes = Buffer.from(JSON.stringify(bundle));
  const metadata = { schema: 'mc.runtime.release.v1', version: bundle.version, source: bundle.source,
    runtime_api: bundle.runtime_api, python_min: bundle.python_min, sequence,
    provided_channels: bundle.provided_channels, channels: bundle.channels, bytes: bytes.length, sha256: sha256(bytes) };
  change(metadata);
  const payload = Buffer.from(JSON.stringify(metadata));
  const envelope = { payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') };
  return async url => new Response(url.endsWith('/v1/stable') ? JSON.stringify(envelope) : bytes);
}
function home(t) {
  const root = mkdtempSync(join(tmpdir(), 'grafly-mc-contract-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'config.json'), JSON.stringify({ url: 'https://release.invalid', token: 'x'.repeat(64), python,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), minimumVersion: '0.1.0' }));
  return root;
}
function consumer(root) {
  const uri = new URL('../dist/circuit/judge.js', import.meta.url).href;
  const proc = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {SYMBOL_CHANNEL,judgeSymbols} from ${JSON.stringify(uri)}; console.log(JSON.stringify({channel:SYMBOL_CHANNEL,result:judgeSymbols({edges:[]},'probe',[])}));`],
    { encoding: 'utf8', timeout: 10000, windowsHide: true, env: { ...process.env, MC_ROOT: '', GRAFLY_MC_RUNTIME_HOME: root } });
  assert.equal(proc.status, 0, proc.stderr); return JSON.parse(proc.stdout);
}
function qualityOutput(bundle, code) {
  edit(bundle, 'morecoffee/channels/channel_host.py', text => text.replace('if __name__ == "__main__":',
    `_original_handle = handle\ndef handle(raw):\n    result = _original_handle(raw)\n${code.split('\n').map(line => '    ' + line).join('\n')}\n    return result\n\nif __name__ == "__main__":`));
}
function toolOutput(bundle, code) {
  edit(bundle, 'morecoffee/channels/tool_output_stdio.py', text => text.replace('    sys.stdout.buffer.write(',
    code.split('\n').map(line => '    ' + line).join('\n') + '\n    sys.stdout.buffer.write('));
}

test('signed future implementation versions activate and the real next consumer sees them', real, async t => {
  const root = home(t);
  await syncRuntime(root, { transport: signed(packageFixture(), 5) });
  const initial = pinRuntime({ GRAFLY_MC_RUNTIME_HOME: root });
  for (const [version, runtime, sequence] of [['0.2.2', '0.3.3', 6], ['0.3.7', '0.3.4', 7], ['2.0.0', '0.3.5', 8]]) {
    const result = await syncRuntime(root, { transport: signed(future(version, runtime), sequence) });
    assert.equal(result.status, 'updated'); assert.equal(result.version, runtime);
    const actual = consumer(root);
    assert.equal(actual.channel.source, 'signed-runtime'); assert.equal(actual.channel.version, version);
    assert.equal(actual.channel.runtimeVersion, runtime); assert.equal(actual.result.verdict, 'abstain');
    validatePinned(initial); // A request already running retains its verified version.
  }
});

test('incompatible signed candidates preserve the active consumer, status, learning models and feedback', real, async t => {
  const root = home(t), learning = join(root, 'learning'); mkdirSync(learning); mkdirSync(join(learning, 'models'));
  const artifact = JSON.parse(Buffer.from(packageFixture().files['morecoffee/channels/portable/symbol_disambiguation.json'].data, 'base64'));
  const symbolModel = { schema: 'mc.learned.v1', policy: 'mc.grouped-fresh-audit.v1', task: 'symbol_disambiguation', approved: true,
    abstain_gap: 0.5, bias: 0, weights: { ...artifact.weights, exact_name: 32 } };
  const qualityModel = { schema: 'mc.learned.v1', policy: 'mc.grouped-fresh-audit.v1', task: 'patch_quality', approved: true,
    bias: -32, weights: Object.fromEntries(['added', 'removed', 'files', 'test_files', 'regression_tests', 'preservation_tests'].map(k => [k, 0])) };
  const symbolSha = sha256(JSON.stringify(symbolModel)), qualitySha = sha256(JSON.stringify(qualityModel));
  const state = { 'config.json': { schema: 'mc.learning.config.v1', enabled: true },
    'active.json': { schema: 'mc.learning.active.v1', models: { patch_quality: qualitySha, symbol_disambiguation: symbolSha } },
    [`models/${symbolSha}.json`]: symbolModel, [`models/${qualitySha}.json`]: qualityModel,
    'inbox.json': { outcome: 'operator evidence' } };
  for (const [path, value] of Object.entries(state)) writeFileSync(join(learning, path), JSON.stringify(value));
  const learningBefore = Object.fromEntries(Object.keys(state).map(path => [path, readFileSync(join(learning, path), 'utf8')]));
  const previous = process.env.MC_LEARNING_HOME; process.env.MC_LEARNING_HOME = learning;
  t.after(() => { if (previous === undefined) delete process.env.MC_LEARNING_HOME; else process.env.MC_LEARNING_HOME = previous; });
  await syncRuntime(root, { transport: signed(packageFixture(), 5) });
  const active = readFileSync(join(root, 'active.json'), 'utf8'), status = readFileSync(join(root, 'status.json'), 'utf8');
  const before = consumer(root);
  assert.equal(before.result.model_sha256, symbolSha); // The real consumer still uses the operator's model.
  const cases = [
    ['release schema', () => {}, m => { m.schema = 'mc.runtime.release.v2'; }],
    ['runtime API', b => { b.runtime_api = 4; }],
    ['bundle schema', b => { b.schema = 'mc.runtime.bundle.v2'; }],
    ['invalid channel semver', b => { b.channels.patch_quality.version = '0.3.x'; b.channels.patch_quality.tag = 'channel/patch_quality/v0.3.x'; }],
    ['channel tag', b => { b.channels.patch_quality.tag = 'channel/patch_quality/v0.2.1'; }],
    ['quality version mismatch', b => { b.channels.patch_quality = { version: '0.3.8', tag: 'channel/patch_quality/v0.3.8' }; }],
    ['quality schema', b => qualityOutput(b, "result['schema_version'] = 'mc.channel.v2'")],
    ['quality required identity', b => qualityOutput(b, "result.pop('request_id')")],
    ['quality provenance', b => qualityOutput(b, "result['provenance']['evidence_sha'] = '0' * 64")],
    ['quality baseline identity', b => qualityOutput(b, "if result.get('decision'):\n    result['decision']['baseline_id'] = 'other'")],
    ['always abstains', b => qualityOutput(b, "result['status'] = 'abstained'\nresult['decision'] = None")],
    ['incomplete evidence approved', b => qualityOutput(b, "if result['request_id'] == 'smoke-quality-2':\n    result['status'] = 'ok'")],
    ['stale review approved', b => qualityOutput(b, "if result['request_id'] == 'smoke-quality-3':\n    result['status'] = 'ok'")],
    ['rejected review approved', b => qualityOutput(b, "if result['request_id'] == 'smoke-quality-4':\n    result['decision']['verdict'] = 'improved'")],
    ['missing review approved', b => qualityOutput(b, "if result['request_id'] == 'smoke-quality-5':\n    result['status'] = 'ok'")],
    ['symbol schema', b => edit(b, 'morecoffee/channels/portable/symbol_disambiguation.json', text => {
      const artifact = JSON.parse(text); artifact.schema = 'mc.symbol_disambiguation.v2'; return JSON.stringify(artifact);
    })],
    ['symbol version mismatch', b => edit(b, 'morecoffee/channels/portable/symbol_disambiguation.json', text => {
      const artifact = JSON.parse(text); artifact.channel_version = '0.3.8'; return JSON.stringify(artifact);
    })],
    ['symbol required feature missing', b => edit(b, 'morecoffee/channels/portable/symbol_disambiguation.json', text => {
      const artifact = JSON.parse(text); delete artifact.weights.exact_name; return JSON.stringify(artifact);
    })],
    ['symbol nonempty result missing node', b => edit(b, 'morecoffee/channels/portable/symbol_disambiguation.mjs', text =>
      text.replace('export function rankFeatures(', 'function originalRankFeatures(') +
      '\nexport function rankFeatures(candidates, options) { const result = originalRankFeatures(candidates, options); for (const candidate of result.ranked) delete candidate.node; return result; }\n')],
    ['tool output schema', b => toolOutput(b, "result.pop('schema_version')")],
    ['tool output required stream', b => toolOutput(b, "result['decision']['streams'].pop('stderr')")],
    ['tool output request identity', b => toolOutput(b, "result['request_id'] = 'different-request'")],
    ['tool output version', b => toolOutput(b, "result['channel_version'] = '0.9.9'")],
    ['tool output range overflow', b => toolOutput(b, "result['decision']['streams']['stdout']['keep'] = [[0, 251]]")],
    ['tool output overlapping ranges', b => toolOutput(b, "result['decision']['streams']['stdout']['keep'] = [[0, 200], [190, 210]]")],
    ['tool output byte mismatch', b => toolOutput(b, "result['decision']['streams']['stdout']['output_bytes'] += 1")],
    ['tool output discards every hit', b => toolOutput(b, "result['decision']['streams']['stdout']['keep'] = []\nresult['decision']['streams']['stdout']['output_bytes'] = 0\nresult['decision']['output_bytes'] = 0")],
  ];
  for (const [name, mutate, metadata] of cases) await t.test(name, async () => {
    const bundle = future('0.3.7'); mutate(bundle);
    await assert.rejects(syncRuntime(root, { transport: signed(bundle, 6, metadata) }));
    assert.equal(readFileSync(join(root, 'active.json'), 'utf8'), active);
    assert.equal(readFileSync(join(root, 'status.json'), 'utf8'), status);
    assert.deepEqual(Object.fromEntries(Object.keys(state).map(path => [path, readFileSync(join(learning, path), 'utf8')])), learningBefore);
    assert.deepEqual(readdirSync(join(learning, 'models')).sort(), [symbolSha + '.json', qualitySha + '.json'].sort());
    assert.deepEqual(consumer(root), before);
  });
  assert.equal(resolveRuntime(root).status, 'ok');
  assert.deepEqual(readdirSync(learning).sort(), ['active.json', 'config.json', 'inbox.json', 'models']);
});

test('real historical API1 and API2 packages retain their supported wire contracts', real, async t => {
  for (const [tag, api, files] of [['mc/v0.2.1', 1, FILES], ['mc/v0.2.3', 2, FILES_V2]]) {
    const git = (...args) => spawnSync('git', ['-C', resolve(source), ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 512 * 1024 });
    const commit = git('rev-parse', '--verify', tag + '^{commit}');
    if (commit.status !== 0) { await t.test(tag, { skip: 'historical fixture unavailable in this source checkout' }, () => {}); continue; }
    await t.test(tag, async st => {
      const bundle = { schema: 'mc.runtime.bundle.v1', version: tag.slice('mc/v'.length), source: commit.stdout.trim(),
        runtime_api: api, python_min: '3.11', provided_channels: api === 1 ? ['tool_output'] : ['tool_output', 'symbol_disambiguation'], files: {} };
      for (const file of files) {
        const result = git('show', `${tag}:${file}`); assert.equal(result.status, 0, result.stderr);
        const bytes = Buffer.from(result.stdout); bundle.files[file] = { data: bytes.toString('base64'), sha256: sha256(bytes) };
      }
      const catalog = Buffer.from(bundle.files['morecoffee/channels/builtin/catalog.py'].data, 'base64').toString('utf8');
      bundle.channels = Object.fromEntries(bundle.provided_channels.map(id => {
        const version = catalog.match(new RegExp(`channel_id="${id}", version="([^"]+)"`))?.[1];
        assert.ok(version); return [id, { version, tag: `channel/${id}/v${version}` }];
      }));
      const root = home(st);
      assert.equal((await syncRuntime(root, { transport: signed(bundle) })).status, 'updated');
      assert.equal(resolveRuntime(root).metadata.runtime_api, api);
    });
  }
});

test('compatible tool-output selection changes keep bounded extraction semantics', real, async t => {
  const root = home(t), bundle = future('0.3.7');
  toolOutput(bundle, "stream = result['decision']['streams']['stdout']\nstream['keep'] = [[0, 100], [225, 250]]\nstream['shown_lines'] = 125\nstream['removed_lines'] = 125\nlines = json.loads(raw)['stdout'].splitlines(keepends=True)\nstream['output_bytes'] = len((''.join(lines[:100]) + ''.join(lines[225:250])).encode('utf-8'))\nresult['decision']['output_bytes'] = stream['output_bytes']");
  assert.equal((await syncRuntime(root, { transport: signed(bundle) })).status, 'updated');
  assert.equal(consumer(root).channel.version, '0.3.7');
});

test('resident callers use a compatible signed rule update on the next request', real, async t => {
  const root = home(t), repo = join(root, 'repo'); mkdirSync(repo);
  const names = ['GRAFLY_MC_RUNTIME_HOME', 'MC_ROOT', 'MC_LEARNING_HOME', 'GRAFLY_WEIGHTS'];
  const previous = Object.fromEntries(names.map(k => [k, process.env[k]]));
  t.after(() => { for (const name of names) previous[name] === undefined ? delete process.env[name] : process.env[name] = previous[name]; });
  process.env.GRAFLY_MC_RUNTIME_HOME = root; process.env.MC_LEARNING_HOME = join(root, 'no-learning');
  delete process.env.MC_ROOT; delete process.env.GRAFLY_WEIGHTS;
  await syncRuntime(root, { transport: signed(packageFixture(), 5) });
  for (const name of ['a', 'b']) writeFileSync(join(repo, name + '.js'), 'export function choose() {}');
  const build = await executeCliRequest({ command: 'build', argv: ['build', '.'], cwd: repo });
  assert.equal(build.exitCode, 0, build.stderr);
  const request = { command: 'callers', argv: ['callers', 'choose', '--json'], cwd: repo };
  const first = await executeCliRequest(request); assert.equal(first.exitCode, 0, first.stderr);
  const before = JSON.parse(first.stdout).circuit.scores;
  const bundle = future('0.3.7');
  edit(bundle, 'morecoffee/channels/portable/symbol_disambiguation.json', text => {
    const artifact = JSON.parse(text); artifact.weights.exact_name += 0.25; return JSON.stringify(artifact);
  });
  await syncRuntime(root, { transport: signed(bundle) });
  const next = await executeCliRequest(request); assert.equal(next.exitCode, 0, next.stderr);
  assert.deepEqual(JSON.parse(next.stdout).circuit.scores, before.map(row => ({ ...row, score: Number((row.score + 0.25).toFixed(3)) })));
});
