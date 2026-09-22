/** Signed, per-user MC runtime. No network or installation on the command path. */
import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, lstatSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';

export const MAX_BYTES = 512 * 1024;
export const FILES = [
  'morecoffee/__init__.py', 'morecoffee/channels/__init__.py',
  'morecoffee/channels/contracts.py', 'morecoffee/channels/registry.py',
  'morecoffee/channels/runner.py', 'morecoffee/channels/tool_output_stdio.py',
  'morecoffee/channels/builtin/__init__.py', 'morecoffee/channels/builtin/catalog.py',
  'morecoffee/channels/builtin/tool_output.py',
].sort();
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const runtimeHome = (env = process.env) => resolve(env.GRAFLY_MC_RUNTIME_HOME || join(homedir(), '.grafly', 'mc-runtime'));
const fail = code => { throw new Error(code); };
const stableVersion = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) && value.length < 40;
export function compareVersion(a, b) {
  for (let i = 0; i < 3; i++) {
    const x = BigInt(a.split('.')[i]), y = BigInt(b.split('.')[i]);
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}
function regular(path) {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) fail('mc_nonregular_file');
  return info;
}
function boundedRead(path, max = MAX_BYTES) {
  if (regular(path).size > max) fail('mc_file_size');
  return readFileSync(path);
}
export function readConfig(home = runtimeHome()) {
  const path = join(home, 'config.json');
  if (!existsSync(path)) return null;
  const c = JSON.parse(boundedRead(path, 16384));
  const url = new URL(c.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || typeof c.token !== 'string' || c.token.length < 32 || c.token.length > 512
      || !isAbsolute(c.python ?? '') || !existsSync(c.python)
      || createPublicKey(c.publicKey).asymmetricKeyType !== 'ed25519'
      || !stableVersion(c.minimumVersion)) fail('mc_invalid_config');
  return { ...c, url: c.url.replace(/\/$/, '') };
}
export function verifyEnvelope(envelope, config) {
  if (typeof envelope?.payload !== 'string' || envelope.payload.length > 32768
      || typeof envelope.signature !== 'string') fail('mc_signature');
  const bytes = Buffer.from(envelope.payload, 'base64');
  if (!verify(null, bytes, config.publicKey, Buffer.from(envelope.signature, 'base64'))) fail('mc_signature');
  const m = JSON.parse(bytes);
  if (m.schema !== 'mc.runtime.release.v1' || !stableVersion(m.version)
      || compareVersion(m.version, config.minimumVersion) < 0 || m.runtime_api !== 1 || m.python_min !== '3.11'
      || !/^[a-f0-9]{40}$/.test(m.source) || !/^[a-f0-9]{64}$/.test(m.sha256)
      || !Number.isSafeInteger(m.sequence) || m.sequence < 1
      || !Number.isSafeInteger(m.bytes) || m.bytes < 1 || m.bytes > MAX_BYTES
      || JSON.stringify(m.provided_channels) !== '["tool_output"]') fail('mc_release_contract');
  return m;
}
export function verifyBundle(bytes, metadata) {
  if (bytes.length !== metadata.bytes || bytes.length > MAX_BYTES || sha256(bytes) !== metadata.sha256) fail('mc_bundle_hash');
  const b = JSON.parse(bytes);
  if (b.schema !== 'mc.runtime.bundle.v1' || b.version !== metadata.version || b.source !== metadata.source
      || b.runtime_api !== 1 || b.python_min !== metadata.python_min
      || JSON.stringify(b.channels) !== JSON.stringify(metadata.channels)
      || JSON.stringify(b.provided_channels) !== '["tool_output"]'
      || JSON.stringify(Object.keys(b.files ?? {}).sort()) !== JSON.stringify(FILES)) fail('mc_bundle_contract');
  for (const f of Object.values(b.files)) {
    if (typeof f.data !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256)) fail('mc_file_contract');
    const data = Buffer.from(f.data, 'base64');
    if (data.toString('base64') !== f.data || sha256(data) !== f.sha256) fail('mc_file_hash');
    new TextDecoder('utf-8', { fatal: true }).decode(data);
  }
  return b;
}
function verifyTree(root, bundle) {
  const expected = new Set([...FILES, 'bundle.json']);
  const directories = new Set(['morecoffee', 'morecoffee/channels', 'morecoffee/channels/builtin']);
  const walk = (dir, prefix = '') => {
    if (lstatSync(dir).isSymbolicLink()) fail('mc_symlink');
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + entry.name, path = join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (!directories.has(name)) fail('mc_unexpected_directory');
        walk(path, name + '/');
      }
      else {
        if (!expected.delete(name)) fail('mc_unexpected_file');
        regular(path);
        if (name !== 'bundle.json' && sha256(boundedRead(path)) !== bundle.files[name].sha256) fail('mc_file_hash');
      }
    }
  };
  walk(root);
  if (expected.size) fail('mc_missing_file');
}
export function validatePinned(pinned) {
  if (pinned?.error) fail(pinned.error);
  if (!pinned) return;
  const bundle = verifyBundle(boundedRead(join(pinned.root, 'bundle.json')), pinned.metadata);
  verifyTree(pinned.root, bundle);
}
export function pinRuntime(env = process.env) {
  // An explicit local development override remains deliberate and visible.
  if (env.MC_ROOT) return null;
  const home = runtimeHome(env);
  try {
    const config = readConfig(home);
    if (!config) return null;
    const envelope = JSON.parse(boundedRead(join(home, 'active.json'), 65536));
    const metadata = verifyEnvelope(envelope, config);
    const pinned = { root: join(home, 'versions', metadata.sha256), python: config.python, metadata };
    validatePinned(pinned);
    return pinned;
  } catch { return { error: 'mc_managed_unavailable' }; }
}
export function atomicWrite(path, data) {
  const temp = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, data, { flag: 'wx', mode: 0o600, flush: true });
  renameSync(temp, path);
}
export function acquireLock(home, name = 'update.lock') {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, name);
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // A crashed owner is recoverable. Missing/incomplete ownership is retried later.
    let owner;
    try { owner = JSON.parse(boundedRead(join(path, 'owner.json'), 1024)); } catch { return null; }
    if (!Number.isInteger(owner.pid) || owner.pid < 1) return null;
    try { process.kill(owner.pid, 0); return null; }
    catch (e) { if (e.code !== 'ESRCH') return null; }
    try { renameSync(path, path + '.stale-' + randomUUID()); mkdirSync(path, { mode: 0o700 }); }
    catch { return null; }
  }
  writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
  return () => { unlinkSync(join(path, 'owner.json')); rmdirSync(path); };
}
export async function download(config, path, max, transport = fetch) {
  const response = await transport(config.url + path, { headers: { Authorization: `Bearer ${config.token}` },
    redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok) fail(response.status === 404 ? 'mc_no_release' : 'mc_download_status');
  if (Number(response.headers.get('content-length')) > max) fail('mc_download_size');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > max) { await response.body.cancel?.().catch(() => {}); fail('mc_download_size'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export function smokeTest(root, python) {
  const code = "import sys,runpy; assert sys.version_info >= (3,11); sys.path.insert(0,sys.argv[1]); runpy.run_module('morecoffee.channels.tool_output_stdio',run_name='__main__')";
  const input = { kind: 'search', complete: true, exit_code: 0,
    stdout: Array.from({ length: 250 }, (_, i) => `file${i}.py:${i + 1}:match\n`).join(''), stderr: '' };
  const result = spawnSync(python, ['-I', '-S', '-B', '-X', 'utf8', '-c', code, root], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 10000, maxBuffer: MAX_BYTES, windowsHide: true, cwd: root,
  });
  if (result.status !== 0) fail('mc_smoke_process');
  const output = JSON.parse(result.stdout);
  if (output.status !== 'ok' || output.channel_id !== 'tool_output' || output.decision?.verdict !== 'reduced'
      || JSON.stringify(output.decision.streams?.stdout?.keep) !== '[[0,200]]') fail('mc_smoke_contract');
}
export async function syncRuntime(home = runtimeHome(), { transport = fetch, smoke = smokeTest } = {}) {
  const config = readConfig(home);
  if (!config) fail('mc_not_configured');
  const unlock = acquireLock(home);
  if (!unlock) return { status: 'busy' };
  try {
    const envelope = JSON.parse(await download(config, '/v1/stable', 65536, transport));
    const metadata = verifyEnvelope(envelope, config);
    const activePath = join(home, 'active.json');
    if (existsSync(activePath)) {
      const previous = verifyEnvelope(JSON.parse(boundedRead(activePath, 65536)), config);
      const comparison = compareVersion(metadata.version, previous.version);
      if (metadata.sequence < previous.sequence || comparison < 0
          || (comparison === 0 && metadata.sha256 !== previous.sha256)
          || (metadata.sequence === previous.sequence && metadata.sha256 !== previous.sha256)) fail('mc_downgrade');
      if (metadata.sha256 === previous.sha256) {
        validatePinned({ root: join(home, 'versions', previous.sha256), metadata: previous });
        const status = { status: 'current', version: previous.version, sequence: previous.sequence, checked_at: new Date().toISOString() };
        atomicWrite(join(home, 'status.json'), JSON.stringify(status));
        return status;
      }
    }
    const bytes = await download(config, `/v1/bundles/${metadata.sha256}`, MAX_BYTES, transport);
    const bundle = verifyBundle(bytes, metadata);
    const versions = join(home, 'versions');
    mkdirSync(versions, { recursive: true, mode: 0o700 });
    if (lstatSync(versions).isSymbolicLink()) fail('mc_symlink');
    const stage = join(versions, '.stage-' + randomUUID()), target = join(versions, metadata.sha256);
    mkdirSync(stage, { mode: 0o700 });
    writeFileSync(join(stage, 'bundle.json'), bytes, { flag: 'wx', mode: 0o600 });
    for (const [name, file] of Object.entries(bundle.files)) {
      const path = join(stage, ...name.split('/'));
      mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(path, Buffer.from(file.data, 'base64'), { flag: 'wx', mode: 0o600 });
    }
    verifyTree(stage, bundle);
    smoke(stage, config.python);
    verifyTree(stage, bundle);
    if (existsSync(target)) {
      validatePinned({ root: target, metadata });
      // A previous crash may have installed this immutable version before activation.
    } else renameSync(stage, target);
    atomicWrite(activePath, JSON.stringify(envelope));
    const status = { status: 'updated', version: metadata.version, sequence: metadata.sequence, checked_at: new Date().toISOString() };
    atomicWrite(join(home, 'status.json'), JSON.stringify(status));
    return status;
  } finally { unlock(); }
}
export function runtimeStatus(home = runtimeHome()) {
  const config = readConfig(home);
  if (!config) return { configured: false };
  const pinned = pinRuntime({ GRAFLY_MC_RUNTIME_HOME: home });
  let last_check = null;
  try { last_check = JSON.parse(boundedRead(join(home, 'status.json'), 16384)); } catch { /* first startup */ }
  return { configured: true, url: config.url, healthy: !pinned?.error, version: pinned?.metadata?.version ?? null,
    sequence: pinned?.metadata?.sequence ?? null, channels: pinned?.metadata?.channels ?? null,
    provided_channels: pinned?.metadata?.provided_channels ?? [], last_check };
}
