import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { hookTargets, installCodexHooks } from '../dist/hosts/codex-hooks.js';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { planRetract, runRetract } from '../dist/hosts/retract.js';
import { mergeGraftSettings, mergeGraftHooks } from '../dist/claude/settings-merge.js';
import { mergeGraftHookEntries } from '../dist/hosts/config-write.js';

function fixture(t, { hooks = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'grafly-codex-install-'));
  t.after(() => {
    assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep));
    rmSync(home, { recursive: true, force: true });
  });
  const codex = join(home, '.codex');
  mkdirSync(codex, { recursive: true });
  if (hooks)
    writeFileSync(join(codex, 'hooks.json'), JSON.stringify({
      hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo foreign', timeout: 5 }] }] },
    }, null, 2));
  return { home, codex, cfg: join(codex, 'hooks.json'), dir: join(codex, 'hooks', 'grafly') };
}

const ours = (cfg, event, file) =>
  (JSON.parse(readFileSync(cfg, 'utf8')).hooks[event] ?? [])
    .filter((e) => JSON.stringify(e).includes(file));

test('session-start/prompt run the devin shim; post-edit/stop the generated shim', (t) => {
  const f = fixture(t);
  const results = installCodexHooks(f.home);
  const byId = Object.fromEntries(results.map((r) => [r.id, r.action]));
  assert.equal(byId['codex-hook-shim'], 'created');
  assert.equal(byId['codex-agent-shim'], 'created');
  assert.equal(byId['codex-hooks'], 'updated');
  assert.match(readFileSync(join(f.dir, 'grafly-devin-hook.cjs'), 'utf8'), /autoBuildRoot/);
  for (const [event, file, sub] of [
    ['SessionStart', 'grafly-devin-hook.cjs', 'session-start'],
    ['UserPromptSubmit', 'grafly-devin-hook.cjs', 'prompt'],
    ['PostToolUse', 'grafly-hooks.cjs', 'post-edit'],
    ['Stop', 'grafly-hooks.cjs', 'stop'],
  ]) {
    const [entry] = ours(f.cfg, event, file);
    assert.ok(entry, `${event} -> ${file}`);
    assert.ok(entry.hooks[0].command.includes(`${file}" ${sub}`), entry.hooks[0].command);
  }
  const cfg = JSON.parse(readFileSync(f.cfg, 'utf8'));
  assert.equal(cfg.hooks.SessionStart.length, 2, 'foreign SessionStart entry preserved');
});

test('reinstall replaces prior entries in place instead of stacking', (t) => {
  const f = fixture(t);
  installCodexHooks(f.home);
  const again = installCodexHooks(f.home);
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']) {
    const list = JSON.parse(readFileSync(f.cfg, 'utf8')).hooks[event];
    assert.equal(list.filter((e) => /grafly-(devin-)?hooks?\.cjs/.test(JSON.stringify(e))).length, 1, event);
  }
  assert.equal(again.find((r) => r.id === 'codex-hooks').action, 'unchanged');
});

test('apply:false reports the drift without writing', (t) => {
  const f = fixture(t);
  installCodexHooks(f.home);
  writeFileSync(join(f.dir, 'grafly-devin-hook.cjs'), 'tampered');
  const cfgBefore = readFileSync(f.cfg, 'utf8');
  const plan = installCodexHooks(f.home, { apply: false });
  const byId = Object.fromEntries(plan.map((r) => [r.id, r.action]));
  assert.equal(byId['codex-agent-shim'], 'updated');
  assert.equal(byId['codex-hooks'], 'unchanged');
  assert.equal(readFileSync(join(f.dir, 'grafly-devin-hook.cjs'), 'utf8'), 'tampered');
  assert.equal(readFileSync(f.cfg, 'utf8'), cfgBefore);
});

test('unparseable hooks.json is left alone; absent codex dir installs nothing', (t) => {
  const f = fixture(t, { hooks: false });
  writeFileSync(f.cfg, '{ nope');
  assert.equal(installCodexHooks(f.home).find((r) => r.id === 'codex-hooks').action, 'skipped-unparseable');
  assert.equal(readFileSync(f.cfg, 'utf8'), '{ nope');
  const g = fixture(t, { hooks: false });
  rmSync(g.codex, { recursive: true, force: true });
  assert.deepEqual(hookTargets(g.home), []);
  assert.deepEqual(installCodexHooks(g.home), []);
});

test('mixed hook blocks preserve foreign handlers, metadata and order on upgrade/removal', (t) => {
  const f = fixture(t);
  const first = { type: 'command', command: 'node foreign-guard.cjs', timeout: 9 };
  const last = { type: 'command', command: 'node foreign-after.cjs', timeout: 7 };
  const mixed = { matcher: 'startup', custom: 'preserve', hooks: [first,
    { type: 'command', command: 'node grafly-devin-hook.cjs session-start' }, last] };
  writeFileSync(f.cfg, JSON.stringify({ hooks: { SessionStart: [mixed] } }));
  installCodexHooks(f.home);
  const blocks = JSON.parse(readFileSync(f.cfg, 'utf8')).hooks.SessionStart;
  assert.deepEqual(blocks[0], { ...mixed, hooks: [first] });
  assert.deepEqual(blocks.at(-1), { ...mixed, hooks: [last] });
  const once = readFileSync(f.cfg, 'utf8');
  installCodexHooks(f.home);
  assert.equal(readFileSync(f.cfg, 'utf8'), once, 'second install is idempotent');
  assert.deepEqual(mergeGraftHookEntries([mixed]), [{ ...mixed, hooks: [first] }, { ...mixed, hooks: [last] }]);
  for (const merge of [mergeGraftSettings, mergeGraftHooks]) {
    const { merged } = merge({ hooks: { SessionStart: [mixed] } });
    const kept = merged.hooks.SessionStart.flatMap(e => e.hooks).filter(h => h.command.startsWith('node foreign-'));
    assert.deepEqual(kept, [first, last], 'Claude counterpart preserves the same handlers');
  }
  const mention = { command: 'node foreign.cjs', description: 'works with grafly-hooks.cjs' };
  assert.deepEqual(mergeGraftHookEntries([mention]), [mention], 'metadata is not ownership');
});

test('CODEX_HOME selects the active account and uninstall removes both shim registrations', (t) => {
  const f = fixture(t);
  const custom = join(f.home, 'account');
  mkdirSync(custom);
  const previous = Object.fromEntries(['HOME', 'USERPROFILE', 'CODEX_HOME', 'GRAFLY_DEVIN_DIR'].map(k => [k, process.env[k]]));
  Object.assign(process.env, { HOME: f.home, USERPROFILE: f.home, CODEX_HOME: custom, GRAFLY_DEVIN_DIR: join(f.home, 'absent-devin') });
  t.after(() => { for (const [k, v] of Object.entries(previous)) v === undefined ? delete process.env[k] : process.env[k] = v; });
  assert.equal(homedir(), f.home);
  const defaultBefore = readFileSync(f.cfg, 'utf8');
  installCodexHooks(f.home);
  const cfg = join(custom, 'hooks.json');
  assert.ok(existsSync(cfg));
  assert.equal(readFileSync(f.cfg, 'utf8'), defaultBefore, 'other account is unchanged');
  const root = JSON.parse(readFileSync(cfg, 'utf8'));
  const foreign = { type: 'command', command: 'node foreign-guard.cjs' };
  root.hooks.UserPromptSubmit[0].hooks.push(foreign);
  writeFileSync(cfg, JSON.stringify(root));
  const repo = join(f.home, 'repo'); mkdirSync(repo);
  const opts = { home: f.home, cache: false };
  const plan = planRetract(repo, opts);
  for (const item of plan) assert.ok(resolve(item.path).startsWith(resolve(f.home) + sep), item.path);
  runRetract(repo, opts);
  const remaining = JSON.parse(readFileSync(cfg, 'utf8'));
  assert.deepEqual(remaining, { hooks: { UserPromptSubmit: [{ hooks: [foreign] }] } });
  assert.equal(existsSync(join(custom, 'hooks', 'grafly', 'grafly-devin-hook.cjs')), false);
  assert.equal(existsSync(join(custom, 'hooks', 'grafly', 'grafly-hooks.cjs')), false);
  assert.equal(readFileSync(f.cfg, 'utf8'), defaultBefore);
});

test('copied shim resolves its local installation without a global npm package', (t) => {
  const f = fixture(t);
  installCodexHooks(f.home);
  const shim = join(f.dir, 'grafly-devin-hook.cjs');
  const env = { ...process.env, HOME: f.home, USERPROFILE: f.home, APPDATA: join(f.home, 'AppData'),
    npm_config_prefix: join(f.home, 'npm'), GRAFLY_NO_SELF_UPDATE: '1', GRAFLY_NO_AUTO_INDEX: '1' };
  delete env.GRAFLY_NO_TOOL_ROUTE; delete env.GRAFLY_TOOL_OUTPUT;
  const run = (sub, payload) => spawnSync(process.execPath, [shim, sub], { cwd: f.home, env, windowsHide: true,
    encoding: 'utf8', timeout: 20000, input: JSON.stringify(payload) });
  const result = run('pre-tool', { tool_name: 'exec', tool_input: { command: 'rg marker .' }, shell: 'bash' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.updatedInput.command, /cli\.js/);
  // A moved/uninstalled package must not turn an optional hook into a host error.
  writeFileSync(shim, readFileSync(shim, 'utf8').replace(/const INSTALLED_DIST = .*?;/, 'const INSTALLED_DIST = null;'));
  env.PATH = '';
  const unavailable = run('prompt', { prompt: 'thanks' });
  assert.equal(unavailable.status, 0, unavailable.stderr);
  assert.doesNotMatch(unavailable.stderr, /MODULE_NOT_FOUND/);
});
