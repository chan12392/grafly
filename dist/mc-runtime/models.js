/** Signed model delivery; MC owns feature validation and inference. */
import { verify } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from '../util/subprocess.js';
import { acquireLock, atomicWrite, download, pinRuntime, readConfig, runtimeHome, sha256, validatePinned } from './runtime.js';

export const MODEL_MAX_BYTES = 128 * 1024;
const MANIFEST_MAX_BYTES = 256 * 1024;
const ENVELOPE_MAX_BYTES = 384 * 1024;
export const MODEL_TASKS = Object.freeze(['symbol_disambiguation', 'patch_quality', 'document_suitability', 'tool_call_suitability', 'input_block_retention']);
const fail = code => { throw new Error(code); };
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const headers = ['runtime_api_min', 'model_schema', 'policy', 'scorer_version', 'source_runtime_sha256'];
const reason = error => /^mc_[a-z_]+$/.test(error.message) ? error.message : 'mc_model_update_failed';
export function modelHome(env = process.env) {
  const home = env.MC_MODEL_HOME || join(homedir(), '.morecoffee', 'models');
  const identity = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  if (!isAbsolute(home) || identity(home) === identity(env.MC_LEARNING_HOME || join(homedir(), '.morecoffee', 'learning'))) fail('mc_model_home');
  return resolve(home);
}
function directory(path, create = false) {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('mc_model_directory');
}
function read(path, max = MODEL_MAX_BYTES) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > max) fail('mc_model_file');
  return readFileSync(path);
}
function decode(value, max) {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(max / 3)) fail('mc_model_encoding');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > max || bytes.toString('base64') !== value) fail('mc_model_encoding');
  return bytes;
}
export function verifyModelEnvelope(envelope, config) {
  const bytes = decode(envelope?.payload, MANIFEST_MAX_BYTES), signature = decode(envelope?.signature, 64);
  if (signature.length !== 64 || !verify(null, bytes, config.publicKey, signature)) fail('mc_model_signature');
  const m = JSON.parse(bytes);
  if (!keys(m, ['schema', 'sequence', 'sha256', 'bytes', ...headers, 'models', 'revoked_model_sha256', 'published_at'])
      || m.schema !== 'mc.model.release.v1' || !Number.isSafeInteger(m.sequence) || m.sequence < 1
      || !hash(m.sha256) || !hash(m.source_runtime_sha256) || !Number.isSafeInteger(m.bytes) || m.bytes < 1 || m.bytes > MODEL_MAX_BYTES
      || !Number.isSafeInteger(m.runtime_api_min) || m.runtime_api_min < 5
      || !['model_schema', 'policy', 'scorer_version'].every(k => typeof m[k] === 'string' && m[k].length > 0 && m[k].length < 100)
      || !keys(m.models, MODEL_TASKS) || !Array.isArray(m.revoked_model_sha256)
      || m.revoked_model_sha256.some(x => !hash(x)) || new Set(m.revoked_model_sha256).size !== m.revoked_model_sha256.length
      || typeof m.published_at !== 'string' || !Number.isFinite(Date.parse(m.published_at))) fail('mc_model_release_contract');
  for (const entry of Object.values(m.models)) {
    if (entry !== null && (!keys(entry, ['model_sha256', 'dataset_sha256'])
        || !hash(entry.model_sha256) || !hash(entry.dataset_sha256) || m.revoked_model_sha256.includes(entry.model_sha256)))
      fail('mc_model_release_contract');
  }
  return m;
}
export function verifyModelBundle(bytes, metadata) {
  if (bytes.length !== metadata.bytes || bytes.length > MODEL_MAX_BYTES || sha256(bytes) !== metadata.sha256) fail('mc_model_bundle_hash');
  const bundle = JSON.parse(bytes);
  if (!keys(bundle, ['schema', ...headers, 'models', 'revoked_model_sha256']) || bundle.schema !== 'mc.model.bundle.v1'
      || !headers.every(k => bundle[k] === metadata[k]) || !same(bundle.revoked_model_sha256, metadata.revoked_model_sha256)
      || !keys(bundle.models, MODEL_TASKS)) fail('mc_model_bundle_contract');
  for (const task of MODEL_TASKS) {
    const entry = bundle.models[task], expected = metadata.models[task];
    if (entry === null && expected === null) continue;
    if (!keys(entry, ['sha256', 'content']) || !expected || entry.sha256 !== expected.model_sha256) fail('mc_model_bundle_contract');
    const data = decode(entry.content, 16384), model = JSON.parse(data);
    if (sha256(data) !== entry.sha256 || model.task !== task || model.dataset_sha256 !== expected.dataset_sha256) fail('mc_model_hash');
  }
  return bundle;
}
export function validateModelBundle(bytes, pinned) {
  validatePinned(pinned);
  const code = "import sys;sys.path.insert(0,sys.argv[1]);from morecoffee.model_delivery import validate_bundle;validate_bundle(sys.stdin.buffer.read());print('{\"status\":\"ok\"}')";
  const result = spawnSync(pinned.python, ['-I', '-S', '-B', '-X', 'utf8', '-c', code, pinned.root], {
    input: bytes, encoding: 'utf8', windowsHide: true, cwd: pinned.root, timeout: 10000, maxBuffer: 65536,
    env: { ...process.env, MC_MODEL_DISABLED: '1', MC_LEARNING_HOME: join(pinned.root, '.validation-disabled') },
  });
  if (result.status !== 0 || result.stdout.trim() !== '{"status":"ok"}') fail('mc_model_validation');
  validatePinned(pinned);
}
const releasePath = (home, sequence, digest) => join(home, 'releases', `${sequence}-${digest}.json`);
function state(home, config, name) {
  const path = join(home, name + '.json');
  if (!existsSync(path)) return null;
  const pointer = JSON.parse(read(path, MANIFEST_MAX_BYTES));
  if (!Number.isSafeInteger(pointer.sequence) || pointer.sequence < 1 || !hash(pointer.bundle_sha256)) fail('mc_model_state');
  directory(join(home, 'releases'));
  const meta = verifyModelEnvelope(JSON.parse(read(releasePath(home, pointer.sequence, pointer.bundle_sha256), ENVELOPE_MAX_BYTES)), config);
  if (meta.sequence !== pointer.sequence || meta.sha256 !== pointer.bundle_sha256) fail('mc_model_state');
  if (name === 'revocations') {
    if (!keys(pointer, ['schema', 'sequence', 'bundle_sha256', 'revoked_model_sha256']) || pointer.schema !== 'mc.models.revocations.v1'
        || !same(pointer.revoked_model_sha256, meta.revoked_model_sha256)) fail('mc_model_state');
  } else if (!keys(pointer, ['schema', 'sequence', 'bundle_sha256', 'models']) || pointer.schema !== 'mc.models.current.v1'
      || !keys(pointer.models, MODEL_TASKS) || MODEL_TASKS.some(task => pointer.models[task] !== (meta.models[task]?.model_sha256 ?? null))) fail('mc_model_state');
  return meta;
}
function immutable(path, bytes, max = MODEL_MAX_BYTES) {
  if (existsSync(path)) {
    if (!read(path, max).equals(bytes)) fail('mc_model_immutable');
  } else atomicWrite(path, bytes);
}
export async function syncModels(runtime = runtimeHome(), { home = modelHome(), transport = fetch, validate = validateModelBundle } = {}) {
  home = modelHome({ MC_MODEL_HOME: home, MC_LEARNING_HOME: process.env.MC_LEARNING_HOME });
  const config = readConfig(runtime);
  if (!config) fail('mc_not_configured');
  directory(home, true);
  const unlock = acquireLock(home, 'update.lock');
  if (!unlock) return { status: 'busy' };
  const save = result => {
    const status = { ...result, checked_at: new Date().toISOString() };
    atomicWrite(join(home, 'status.json'), JSON.stringify(status));
    return status;
  };
  try {
    const previous = state(home, config, 'revocations'), current = state(home, config, 'current');
    if (current && (!previous || previous.sequence < current.sequence
        || (previous.sequence === current.sequence && previous.sha256 !== current.sha256))) fail('mc_model_state');
    let raw;
    try { raw = await download(config, '/v1/models/stable', ENVELOPE_MAX_BYTES, transport); }
    catch (error) { if (error.message === 'mc_no_release') return save({ status: 'waiting', reason: 'mc_no_model_release' }); throw error; }
    const envelope = JSON.parse(raw), meta = verifyModelEnvelope(envelope, config);
    if (previous && (meta.sequence < previous.sequence || (meta.sequence === previous.sequence && meta.sha256 !== previous.sha256)
        || previous.revoked_model_sha256.some(h => !meta.revoked_model_sha256.includes(h)))) fail('mc_model_downgrade');
    directory(join(home, 'releases'), true);
    immutable(releasePath(home, meta.sequence, meta.sha256), Buffer.from(JSON.stringify(envelope)), ENVELOPE_MAX_BYTES);
    // Revocation must take effect even if the replacement cannot be downloaded or used.
    atomicWrite(join(home, 'revocations.json'), JSON.stringify({ schema: 'mc.models.revocations.v1', sequence: meta.sequence,
      bundle_sha256: meta.sha256, revoked_model_sha256: meta.revoked_model_sha256 }));
    const pinned = pinRuntime({ GRAFLY_MC_RUNTIME_HOME: runtime });
    if (!pinned || pinned.error || pinned.metadata.runtime_api < meta.runtime_api_min
        || meta.model_schema !== 'mc.learned.v1' || meta.policy !== 'mc.grouped-fresh-audit.v1'
        || meta.scorer_version !== 'mc.context-judgment.v1') fail('mc_model_incompatible');
    if (current && MODEL_TASKS.some(task => current.models[task] && meta.models[task] === null
        && !meta.revoked_model_sha256.includes(current.models[task].model_sha256))) fail('mc_model_unrevoked_removal');
    directory(join(home, 'bundles'), true);
    const artifact = join(home, 'bundles', meta.sha256 + '.json');
    const bytes = existsSync(artifact) ? read(artifact) : await download(config, `/v1/models/bundles/${meta.sha256}`, MODEL_MAX_BYTES, transport);
    const bundle = verifyModelBundle(bytes, meta);
    validate(bytes, pinned);
    directory(join(home, 'models'), true);
    for (const entry of Object.values(bundle.models)) if (entry) immutable(join(home, 'models', entry.sha256 + '.json'), decode(entry.content, 16384));
    immutable(artifact, bytes);
    atomicWrite(join(home, 'current.json'), JSON.stringify({ schema: 'mc.models.current.v1', sequence: meta.sequence,
      bundle_sha256: meta.sha256, models: Object.fromEntries(MODEL_TASKS.map(task => [task, meta.models[task]?.model_sha256 ?? null])) }));
    return save({ status: current?.sha256 === meta.sha256 ? 'current' : 'updated', sequence: meta.sequence,
      bundle_sha256: meta.sha256, models: meta.models });
  } catch (error) { save({ status: 'retrying', reason: reason(error) }); throw error; }
  finally { unlock(); }
}
export function modelStatus(runtime = runtimeHome(), home = modelHome()) {
  if (!existsSync(home)) return { status: 'waiting', home, models: null };
  try {
    directory(home);
    const config = readConfig(runtime);
    if (!config) return { status: 'unconfigured', home, models: null };
    const revocations = state(home, config, 'revocations'), current = state(home, config, 'current');
    let last_check = null;
    if (existsSync(join(home, 'status.json'))) last_check = JSON.parse(read(join(home, 'status.json'), 65536));
    if (!current) return { status: 'waiting', home, models: null, revocation_sequence: revocations?.sequence ?? null, last_check };
    if (!revocations || revocations.sequence < current.sequence
        || (revocations.sequence === current.sequence && revocations.sha256 !== current.sha256)) fail('mc_model_state');
    directory(join(home, 'models'));
    const models = Object.fromEntries(MODEL_TASKS.map(task => {
      const entry = current.models[task];
      if (!entry || revocations.revoked_model_sha256.includes(entry.model_sha256)) return [task, null];
      const bytes = read(join(home, 'models', entry.model_sha256 + '.json'), 16384);
      if (sha256(bytes) !== entry.model_sha256) fail('mc_model_hash');
      return [task, entry];
    }));
    return { status: 'ok', home, sequence: current.sequence, bundle_sha256: current.sha256,
      revocation_sequence: revocations.sequence, models, last_check };
  } catch { return { status: 'error', reason: 'mc_model_state_invalid', home, models: null }; }
}
