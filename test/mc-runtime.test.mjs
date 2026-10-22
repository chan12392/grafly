import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FILES, sha256, syncRuntime, pinRuntime, validatePinned, runtimeStatus, verifyEnvelope, verifyBundle, acquireLock } from '../dist/mc-runtime/runtime.js';
import { runCommand, judge } from '../dist/tool-output/runner.js';
import { FILES_V2 } from '../dist/mc-runtime/runtime.js';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
function release(version = '0.2.0', sequence = 1, mutate = () => {}) {
  const text = Buffer.from(`# fixture ${version}\n`);
  const b = { schema: 'mc.runtime.bundle.v1', version, source: 'a'.repeat(40), runtime_api: 1, python_min: '3.11',
    provided_channels: ['tool_output'], channels: { tool_output: { version: '0.2.1', tag: 'channel/tool_output/v0.2.1' } },
    files: Object.fromEntries(FILES.map(f => [f, { data: text.toString('base64'), sha256: sha256(text) }])) };
  mutate(b);
  const bytes = Buffer.from(JSON.stringify(b));
  const m = { schema: 'mc.runtime.release.v1', version, sequence, source: b.source, runtime_api: b.runtime_api,
    python_min: b.python_min, provided_channels: b.provided_channels, channels: b.channels, sha256: sha256(bytes), bytes: bytes.length };
  const payload = Buffer.from(JSON.stringify(m));
  return { bytes, metadata: m, envelope: { payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') } };
}
function home() {
  const dir = mkdtempSync(join(tmpdir(), 'grafly-mc-test-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ url: 'https://release.example/mc-releases', token: 'x'.repeat(64),
    python: process.execPath, publicKey, minimumVersion: '0.1.0' }));
  return dir;
}
const transport = r => async (url, options) => {
  assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer ' + 'x'.repeat(64));
  return new Response(url.endsWith('/v1/stable') ? JSON.stringify(r.envelope) : r.bytes, { status: 200 });
};
const install = (h, r, smoke = () => {}) => syncRuntime(h, { transport: transport(r), smoke });
const env = h => {
  const result = { ...process.env, GRAFLY_TOOL_OUTPUT: '1', MC_ROOT: '', GRAFLY_MC_RUNTIME_HOME: h };
  delete result.NODE_TEST_CONTEXT;
  return result;
};

test('signed install, atomic version switch, offline survival and command pinning', async () => {
  const h = home(), a = release(), b = release('0.2.1', 2);
  assert.equal((await install(h, a)).status, 'updated');
  const pinned = pinRuntime(env(h)); assert.equal(pinned.metadata.version, '0.2.0');
  assert.equal((await install(h, a)).status, 'current');
  await install(h, b); assert.equal(pinRuntime(env(h)).metadata.version, '0.2.1');
  validatePinned(pinned); assert.ok(existsSync(pinned.root));
  await assert.rejects(syncRuntime(h, { transport: async () => { throw new Error('offline'); } }));
  assert.equal(runtimeStatus(h).version, '0.2.1');
});
test('v2 signed portable channel is loaded by the actual Grafly judge, with v1 still supported', async () => {
  const h = home(); await install(h, release());
  const r = release('0.3.0', 2, b => {
    b.runtime_api = 2; b.provided_channels.push('symbol_disambiguation');
    b.channels.symbol_disambiguation = { version: '0.2.0', tag: 'channel/symbol_disambiguation/v0.2.0' };
    for (const name of FILES_V2.filter(f => !FILES.includes(f))) {
      const data = name.endsWith('.py') ? Buffer.from('# fixture\n') : readFileSync(new URL('../dist/circuit/mc/' + name.split('/').at(-1), import.meta.url));
      b.files[name] = { data: data.toString('base64'), sha256: sha256(data) };
    }
  });
  await install(h, r);
  const module = new URL('../dist/circuit/judge.js', import.meta.url).href;
  const proc = spawnSync(process.execPath, ['--input-type=module', '-e', `import {SYMBOL_CHANNEL,judgeSymbols} from ${JSON.stringify(module)}; console.log(JSON.stringify({channel:SYMBOL_CHANNEL,result:judgeSymbols({edges:[]},'run',[])}));`],
    { env: env(h), encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(proc.status, 0, proc.stderr);
  const output = JSON.parse(proc.stdout);
  assert.equal(output.channel.source, 'signed-runtime'); assert.equal(output.channel.version, '0.2.0');
  assert.equal(output.result.verdict, 'abstain'); assert.equal(output.result.reason, 'no_candidates');
  const pinned = pinRuntime(env(h));
  writeFileSync(join(pinned.root, 'morecoffee/channels/portable/symbol_disambiguation.mjs'), 'throw new Error("tampered")');
  assert.throws(() => validatePinned(pinned), /mc_file_hash/);
});
test('signature, compatibility, file hashes and path traversal fail before executing candidates', async () => {
  for (const alter of [r => r.envelope.signature = Buffer.alloc(64).toString('base64'),
    r => r.bytes[0] ^= 1]) {
    const h = home(), r = release(); alter(r); let ran = false;
    await assert.rejects(install(h, r, () => { ran = true; })); assert.equal(ran, false);
    assert.equal(existsSync(join(h, 'active.json')), false);
  }
  for (const mutate of [b => b.files['../evil.py'] = b.files[FILES[0]], b => b.runtime_api = 2,
    b => b.files[FILES[0]].sha256 = '0'.repeat(64)]) {
    const h = home(); let ran = false;
    await assert.rejects(install(h, release('0.2.0', 1, mutate), () => { ran = true; })); assert.equal(ran, false);
  }
  const r = release();
  assert.throws(() => verifyEnvelope(r.envelope, { publicKey: generateKeyPairSync('ed25519').publicKey, minimumVersion: '0.1.0' }));
  assert.throws(() => verifyBundle(Buffer.from('bad'), r.metadata));
});
test('downgrade, replay and immutable-version violations leave last good version active', async () => {
  const h = home(); await install(h, release('0.2.1', 2));
  const before = readFileSync(join(h, 'active.json'), 'utf8');
  for (const r of [release('0.2.0', 1), release('0.2.0', 3), release('0.2.2', 1),
    release('0.2.1', 3, b => { b.source = 'b'.repeat(40); })]) await assert.rejects(install(h, r), /mc_downgrade/);
  assert.equal(readFileSync(join(h, 'active.json'), 'utf8'), before);
});
test('smoke failure and interrupted staging cannot replace an active version', async () => {
  const h = home(); await install(h, release());
  await assert.rejects(install(h, release('0.2.1', 2), () => { throw new Error('incompatible'); }));
  assert.equal(runtimeStatus(h).version, '0.2.0');
  assert.equal((await install(h, release('0.2.1', 2))).status, 'updated');
});
test('concurrent updates are serialized; crashed locks recover', async () => {
  const h = home(), unlock = acquireLock(h);
  assert.equal((await install(h, release())).status, 'busy'); unlock();
  const lock = join(h, 'update.lock'); mkdirSync(lock); writeFileSync(join(lock, 'owner.json'), '{"pid":2147483647}');
  assert.equal((await install(h, release())).status, 'updated');
});
test('disk tampering and added Python bytecode fail closed; explicit development override works', async () => {
  const h = home(); await install(h, release());
  const pinned = pinRuntime(env(h));
  writeFileSync(join(pinned.root, 'morecoffee', '__init__.pyc'), 'bad');
  assert.equal(pinRuntime(env(h)).error, 'mc_managed_unavailable');
  assert.throws(() => judge({ kind: 'search' }, env(h)), /mc_managed_unavailable/);
  assert.equal(pinRuntime({ ...env(h), MC_ROOT: '/explicit/dev' }), null);
});
test('an explicit unavailable Python override stays unavailable with managed code installed', async () => {
  const h = home(); await install(h, release());
  assert.throws(() => judge({ kind: 'search' }, { ...env(h), MC_PYTHON: join(h, 'missing-python') }), /mc_unavailable/);
});
test('a command started before activation judges with its starting runtime', async () => {
  const h = home(); await install(h, release());
  const script = join(h, 'slow.test.mjs');
  writeFileSync(script, "import test from 'node:test'; test('delayed', async () => { await new Promise(r => setTimeout(r, 500)); for(let i=0;i<300;i++) console.log('long transcript line '+i); });");
  const sink = { write() {} }; let selected;
  const running = runCommand(process.execPath, ['--test', script], { env: env(h), archiveDir: join(h, 'archive'), stdout: sink, stderr: sink,
    judge: (_payload, _env, pinned) => { selected = pinned.metadata.version; return { decision: { verdict: 'passthrough' } }; } });
  await install(h, release('0.2.1', 2));
  const result = await running;
  assert.equal(result.exit_code, 0); assert.equal(selected, '0.2.0', JSON.stringify(result)); assert.equal(runtimeStatus(h).version, '0.2.1');
});
