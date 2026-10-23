/** Signed, per-user MC runtime. No network or installation on the command path. */
import { createHash, createPublicKey, verify, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, lstatSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { acquireProcessLock } from '../util/process-lock.js';

export const MAX_BYTES = 512 * 1024;
export const FILES = [
  'morecoffee/__init__.py', 'morecoffee/channels/__init__.py',
  'morecoffee/channels/contracts.py', 'morecoffee/channels/registry.py',
  'morecoffee/channels/runner.py', 'morecoffee/channels/tool_output_stdio.py',
  'morecoffee/channels/builtin/__init__.py', 'morecoffee/channels/builtin/catalog.py',
  'morecoffee/channels/builtin/tool_output.py',
].sort();
export const FILES_V2 = [...FILES, 'morecoffee/channels/builtin/symbol_disambiguation.py',
  'morecoffee/channels/portable/symbol_disambiguation.mjs', 'morecoffee/channels/portable/symbol_disambiguation.json'].sort();
export const FILES_V3 = [...FILES_V2, 'morecoffee/channels/channel_host.py', 'morecoffee/channels/builtin/patch_quality.py', 'morecoffee/adaptive.py'].sort();
export const FILES_V4 = [...FILES_V3, 'morecoffee/judgment.py', 'morecoffee/channels/builtin/context_judgment.py'].sort();
export const FILES_V5 = [...FILES_V4, 'morecoffee/model_delivery.py', 'morecoffee/learning_service.py'].sort();
const provided = api => api === 1 ? ['tool_output'] : api === 2 ? ['tool_output', 'symbol_disambiguation']
  : ['tool_output', 'symbol_disambiguation', 'patch_quality', ...(api >= 4 ? ['context_judgment'] : [])];
const filesFor = api => api === 1 ? FILES : api === 2 ? FILES_V2 : api === 3 ? FILES_V3 : api === 4 ? FILES_V4 : FILES_V5;
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export const runtimeHome = (env = process.env) => resolve(env.GRAFLY_MC_RUNTIME_HOME || join(homedir(), '.grafly', 'mc-runtime'));
const fail = code => { throw new Error(code); };
const stableVersion = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) && value.length < 40;
const validChannels = (channels, api) => channels && typeof channels === 'object' && !Array.isArray(channels)
  && provided(api).every(id => Object.hasOwn(channels, id))
  && Object.entries(channels).every(([id, channel]) => /^[a-z][a-z0-9_]{0,63}$/.test(id)
    && stableVersion(channel?.version) && channel.tag === `channel/${id}/v${channel.version}`);
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
      || compareVersion(m.version, config.minimumVersion) < 0 || ![1, 2, 3, 4, 5].includes(m.runtime_api) || m.python_min !== '3.11'
      || !/^[a-f0-9]{40}$/.test(m.source) || !/^[a-f0-9]{64}$/.test(m.sha256)
      || !Number.isSafeInteger(m.sequence) || m.sequence < 1
      || !Number.isSafeInteger(m.bytes) || m.bytes < 1 || m.bytes > MAX_BYTES
       || JSON.stringify(m.provided_channels) !== JSON.stringify(provided(m.runtime_api))
       || !validChannels(m.channels, m.runtime_api)) fail('mc_release_contract');
  return m;
}
export function verifyBundle(bytes, metadata) {
  if (bytes.length !== metadata.bytes || bytes.length > MAX_BYTES || sha256(bytes) !== metadata.sha256) fail('mc_bundle_hash');
  const b = JSON.parse(bytes);
  if (b.schema !== 'mc.runtime.bundle.v1' || b.version !== metadata.version || b.source !== metadata.source
      || ![1, 2, 3, 4, 5].includes(b.runtime_api) || b.runtime_api !== metadata.runtime_api || b.python_min !== metadata.python_min
      || JSON.stringify(b.channels) !== JSON.stringify(metadata.channels)
      || JSON.stringify(b.provided_channels) !== JSON.stringify(provided(b.runtime_api))
      || JSON.stringify(Object.keys(b.files ?? {}).sort()) !== JSON.stringify(filesFor(b.runtime_api))) fail('mc_bundle_contract');
  for (const f of Object.values(b.files)) {
    if (typeof f.data !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256)) fail('mc_file_contract');
    const data = Buffer.from(f.data, 'base64');
    if (data.toString('base64') !== f.data || sha256(data) !== f.sha256) fail('mc_file_hash');
    new TextDecoder('utf-8', { fatal: true }).decode(data);
  }
  return b;
}
function verifyTree(root, bundle) {
  const expected = new Set([...filesFor(bundle.runtime_api), 'bundle.json']);
  const directories = new Set(['morecoffee', 'morecoffee/channels', 'morecoffee/channels/builtin', ...(bundle.runtime_api >= 2 ? ['morecoffee/channels/portable'] : [])]);
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
/** Managed-only read, ignoring development overrides and never contacting the server. */
export function resolveRuntime(home = runtimeHome()) {
  const pinned = pinRuntime({ GRAFLY_MC_RUNTIME_HOME: home });
  const schema = 'grafly.mc-runtime.resolution.v1';
  if (!pinned || pinned.error) return { schema, status: 'error', error: pinned ? 'mc_managed_unavailable' : 'mc_unconfigured' };
  const metadata = Object.fromEntries(['version', 'source', 'sequence', 'sha256', 'runtime_api', 'provided_channels', 'channels'].map(k => [k, pinned.metadata[k]]));
  return { schema, status: 'ok', root: pinned.root, python: pinned.python, metadata };
}
export function atomicWrite(path, data) {
  const temp = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, data, { flag: 'wx', mode: 0o600, flush: true });
  renameSync(temp, path);
}
export function acquireLock(home, name = 'update.lock') {
  return acquireProcessLock(join(home, name));
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
  const bundle = JSON.parse(boundedRead(join(root, 'bundle.json')));
  if (![1, 2, 3, 4, 5].includes(bundle.runtime_api) || !validChannels(bundle.channels, bundle.runtime_api)) fail('mc_smoke_contract');
  // Probe seed contracts, independently of this user's active learned models.
  // This nonexistent, private stage path is only read; no learning state is created.
  const env = { ...process.env, MC_LEARNING_HOME: join(root, '.smoke-learning-disabled'), MC_MODEL_HOME: join(root, '.smoke-models-disabled') };
  const canonical = value => value && typeof value === 'object'
    ? Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
      : '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
    : JSON.stringify(value);
  const envelope = (output, id, requestId, payload, status) => {
    if (output?.schema_version !== 'mc.channel.v1' || output.request_id !== requestId
        || output.channel_id !== id || output.channel_version !== bundle.channels[id].version
        || output.operation !== 'judge' || output.status !== status
        || !['deterministic', 'experimental_learned'].includes(output.engine_mode)
        || output.confidence !== null || output.learned_parameter_count !== 0
        || !Array.isArray(output.scores) || !Array.isArray(output.evidence)
        || !['reason_codes', 'limitations'].every(k => Array.isArray(output[k]) && output[k].every(v => typeof v === 'string'))
        || output.provenance?.channel_version !== output.channel_version
        || output.provenance.evidence_sha !== sha256(canonical(payload))
        || output.safety?.safety_verdict !== 'unknown' || output.safety.safe_to_remove_claims !== false)
      fail(id === 'patch_quality' ? 'mc_smoke_quality_contract' : 'mc_smoke_contract');
  };
  const code = "import sys,runpy; assert sys.version_info >= (3,11); sys.path.insert(0,sys.argv[1]); runpy.run_module('morecoffee.channels.tool_output_stdio',run_name='__main__')";
  const input = { kind: 'search', complete: true, exit_code: 0,
    stdout: Array.from({ length: 250 }, (_, i) => `file${i}.py:${i + 1}:match\n`).join(''), stderr: '' };
  const result = spawnSync(python, ['-I', '-S', '-B', '-X', 'utf8', '-c', code, root], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 10000, maxBuffer: MAX_BYTES, windowsHide: true, cwd: root, env,
  });
  if (result.status !== 0) fail('mc_smoke_process');
  const output = JSON.parse(result.stdout);
  envelope(output, 'tool_output', 'grafly-tool-output', input, 'ok');
  const decision = output.decision;
  if (decision?.verdict !== 'reduced' || decision.input_bytes !== Buffer.byteLength(input.stdout)) fail('mc_smoke_contract');
  let outputBytes = 0;
  for (const name of ['stdout', 'stderr']) {
    const stream = decision.streams?.[name], source = input[name].match(/[^\n]*\n|[^\n]+$/g) ?? [];
    let text = '', end = 0;
    if (typeof stream?.text === 'string') text = stream.text;
    else {
      if (!Array.isArray(stream?.keep)) fail('mc_smoke_contract');
      for (const range of stream.keep) {
        if (!Array.isArray(range) || range.length !== 2) fail('mc_smoke_contract');
        const [a, b] = range;
        if (!Number.isInteger(a) || !Number.isInteger(b) || a < end || b <= a || b > source.length) fail('mc_smoke_contract');
        text += source.slice(a, b).join(''); end = b;
      }
    }
    if (Buffer.byteLength(text) !== stream.output_bytes) fail('mc_smoke_contract');
    outputBytes += stream.output_bytes;
  }
  if (outputBytes !== decision.output_bytes || outputBytes >= decision.input_bytes || outputBytes <= 0) fail('mc_smoke_contract');
  const portable = join(root, 'morecoffee/channels/portable/symbol_disambiguation.mjs');
  if (existsSync(portable)) {
    const check = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const m = await import(process.argv[1]);
      assert.equal(m.ARTIFACT?.schema, 'mc.symbol_disambiguation.v1');
      assert.equal(m.ARTIFACT.channel_id, 'symbol_disambiguation');
      assert.equal(m.ARTIFACT.channel_version, process.argv[2]);
      assert.equal(m.MODEL_SHA256 ?? null, null);
      const keys = ['qualified_tail','exact_name','path_overlap','degree','kind_hint','vendored','test_path','cwd_affinity','bias'];
      assert.deepEqual([...m.FEATURE_KEYS].sort(), [...keys].sort());
      assert.ok(keys.every(k => Number.isFinite(m.DEFAULT_WEIGHTS[k])));
      const features = Object.fromEntries(keys.map(k => [k, k === 'bias' || k === 'exact_name' ? 1 : 0]));
      const candidate = { id: 'smoke-symbol', node: { id: 'smoke-symbol' }, features };
      for (const candidates of [[], [candidate]]) {
        const result = m.rankFeatures(candidates);
        assert.equal(result.verdict, candidates.length ? 'confident' : 'abstain');
        assert.equal(result.gap, null);
        assert.equal(typeof result.reason, 'string');
        assert.equal(result.ranked.length, candidates.length);
        if (candidates.length) {
          assert.equal(result.ranked[0].id, candidate.id);
          assert.equal(result.ranked[0].node.id, candidate.id);
          assert.deepEqual(result.ranked[0].features, features);
          assert.ok(Number.isFinite(result.ranked[0].score));
        }
      }`, pathToFileURL(portable).href, bundle.channels.symbol_disambiguation.version],
       { encoding: 'utf8', timeout: 10000, windowsHide: true, cwd: root, env });
    if (check.status !== 0) fail('mc_smoke_symbol_js');
    const pyCheck = spawnSync(python, ['-I', '-S', '-B', '-c',
      "import sys; sys.path.insert(0,sys.argv[1]); from morecoffee.channels.builtin.symbol_disambiguation import rank_features; assert rank_features([])['verdict']=='abstain'", root],
       { encoding: 'utf8', timeout: 10000, windowsHide: true, cwd: root, env });
    if (pyCheck.status !== 0) fail('mc_smoke_symbol_python');
  }
  if (existsSync(join(root, 'morecoffee/channels/builtin/patch_quality.py'))) {
    const summary = (suite, failures = 0) => ({ complete: true, exit_code: failures ? 1 : 0,
      tests: 1, failures, errors: 0, skipped: 0, suite_id: suite.repeat(64) });
    const positive = { goal: 'correctness', baseline_id: 'smoke-before', candidate_id: 'smoke-after', checks: [
      { id: 'regression', purpose: 'regression', baseline: summary('a', 1), candidate: summary('a') },
      { id: 'preservation', purpose: 'preservation', baseline: summary('b'), candidate: summary('b') }],
      review: { baseline_id: 'smoke-before', candidate_id: 'smoke-after', verdict: 'approved', requirements_preserved: true, scope_preserved: true } };
    const incomplete = structuredClone(positive);
    incomplete.checks[1].candidate.complete = false;
    const stale = structuredClone(positive), rejected = structuredClone(positive), missingReview = structuredClone(positive);
    stale.review.baseline_id = 'different-snapshot'; rejected.review.verdict = 'rejected';
    delete missingReview.review;
    const payloads = [{ goal: 'correctness', baseline_id: 'smoke-before', candidate_id: 'smoke-after', checks: [] }, positive, incomplete, stale, rejected, missingReview];
    const verdicts = [null, 'improved', null, null, 'not_improved', null];
    const requests = payloads.map((payload, i) => ({ schema_version: 'mc.channel.v1', request_id: `smoke-quality-${i}`,
      channel_id: 'patch_quality', operation: 'judge', payload }));
    const check = spawnSync(python, ['-I', '-S', '-B', '-X', 'utf8', '-c',
      "import sys,runpy; sys.path.insert(0,sys.argv[1]); runpy.run_module('morecoffee.channels.channel_host',run_name='__main__')", root], {
       input: requests.map(r => JSON.stringify(r) + '\n').join(''),
       encoding: 'utf8', timeout: 10000, maxBuffer: MAX_BYTES, windowsHide: true, cwd: root, env });
    if (check.status !== 0) fail('mc_smoke_quality_process');
    const lines = check.stdout.trim().split('\n');
    if (lines.length !== requests.length) fail('mc_smoke_quality_contract');
    for (let i = 0; i < requests.length; i++) {
      const output = JSON.parse(lines[i]);
      envelope(output, 'patch_quality', requests[i].request_id, payloads[i], verdicts[i] ? 'ok' : 'abstained');
      if (!verdicts[i]) {
        if (output.decision !== null) fail('mc_smoke_quality_contract');
      } else if (output.decision?.verdict !== verdicts[i] || output.decision.goal !== positive.goal
          || output.decision.baseline_id !== positive.baseline_id || output.decision.candidate_id !== positive.candidate_id
          || !Array.isArray(output.decision.improvements) || (i === 1 && !output.decision.improvements.length)
          || !output.decision.improvements.every(v => typeof v === 'string') || !output.evidence.length) fail('mc_smoke_quality_contract');
    }
  }
  if (bundle.runtime_api >= 4) {
    const payloads = ['document_suitability', 'tool_call_suitability', 'input_block_retention'].map(task => ({
      source: 'grafly', task, group_id: 'a'.repeat(64), case_origin: 'synthetic', goal: 'Preserve required evidence.',
      constraints: [], items: task === 'tool_call_suitability'
        ? [{ id: 'guard', text: 'A tool call violating an independently checked constraint.', protected: false, constraint_status: 'violated' },
           { id: 'unknown', text: 'A proposed tool call.', protected: false, constraint_status: 'unknown' }]
        : [{ id: 'required', text: 'Required current instructions.', protected: true, constraint_status: 'unknown' },
           { id: 'unknown', text: 'Unreviewed material.', protected: false, constraint_status: 'unknown' }],
    }));
    const requests = payloads.map((payload, i) => ({ schema_version: 'mc.channel.v1', request_id: `smoke-context-${i}`,
      channel_id: 'context_judgment', operation: 'judge', payload }));
    const check = spawnSync(python, ['-I', '-S', '-B', '-X', 'utf8', '-c',
      "import sys,runpy; sys.path.insert(0,sys.argv[1]); runpy.run_module('morecoffee.channels.channel_host',run_name='__main__')", root], {
      input: requests.map(r => JSON.stringify(r) + '\n').join(''), encoding: 'utf8', timeout: 10000,
      maxBuffer: MAX_BYTES, windowsHide: true, cwd: root, env });
    if (check.status !== 0) fail('mc_smoke_context_process');
    const rows = check.stdout.trim().split('\n');
    if (rows.length !== requests.length) fail('mc_smoke_context_contract');
    for (let i = 0; i < rows.length; i++) {
      const output = JSON.parse(rows[i]), payload = payloads[i];
      envelope(output, 'context_judgment', requests[i].request_id, payload, 'ok');
      const decision = output.decision;
      const common = Object.fromEntries(['task', 'goal', 'constraints', 'items'].map(k => [k, payload[k]]));
      if (decision?.task !== payload.task || decision.input_sha256 !== sha256(canonical(common))
          || decision.model_version !== 'seed-v1' || decision.model_sha256 !== null || decision.dataset_sha256 !== null
          || decision.judgments?.length !== 2) fail('mc_smoke_context_contract');
      for (let j = 0; j < 2; j++) {
        const row = decision.judgments[j], item = payload.items[j], feedback = row?.feedback;
        if (row?.id !== item.id || row.decision !== (j ? 'abstain' : i === 1 ? 'reject' : 'keep')
            || row.abstained !== Boolean(j) || feedback?.schema !== 'mc.feedback.v2'
            || feedback.task !== payload.task || feedback.input_sha256 !== decision.input_sha256
            || feedback.evidence_sha256 !== sha256(item.text) || feedback.item_id !== sha256(item.id)
            || feedback.teacher !== null || feedback.outcome !== null || row.collection_status !== 'disabled')
          fail('mc_smoke_context_contract');
      }
    }
  }
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
