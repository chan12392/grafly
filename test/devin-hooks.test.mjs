import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { devinHookTargets, installDevinHooks } from '../dist/hosts/devin-hooks.js';
import { planRetract, runRetract } from '../dist/hosts/retract.js';

function fixture(t, { config = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'grafly-devin-install-'));
  t.after(() => {
    assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep));
    rmSync(home, { recursive: true, force: true });
    delete process.env.GRAFLY_DEVIN_DIR;
  });
  const devin = join(home, 'devin');
  mkdirSync(devin, { recursive: true });
  process.env.GRAFLY_DEVIN_DIR = devin;
  if (config)
    writeFileSync(join(devin, 'config.json'), JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'C:\\other\\tool.cmd', timeout: 10 }] }] },
      theme_mode: 'dark',
    }, null, 2));
  return { home, devin, cfg: join(devin, 'config.json') };
}

const graflyEntries = (cfg, event) =>
  (JSON.parse(readFileSync(cfg, 'utf8')).hooks[event] ?? [])
    .filter((e) => JSON.stringify(e).includes('grafly-devin-hook.cjs'));

test('installs shim, runner and three hook events while preserving foreign config', (t) => {
  const f = fixture(t);
  const results = installDevinHooks(f.home);
  const byId = Object.fromEntries(results.map((r) => [r.id, r.action]));
  assert.equal(byId['devin-hook-shim'], 'created');
  assert.equal(byId['devin-hook-runner'], 'created');
  assert.equal(byId['devin-hooks'], 'updated');
  assert.match(readFileSync(join(f.devin, 'hooks', 'grafly-devin-hook.cjs'), 'utf8'), /grafly/);
  assert.match(readFileSync(join(f.devin, 'hooks', 'stdin-complete-run.cjs'), 'utf8'), /runIfComplete/);
  const cfg = JSON.parse(readFileSync(f.cfg, 'utf8'));
  assert.equal(cfg.theme_mode, 'dark');
  assert.equal(cfg.hooks.SessionStart.length, 2, 'foreign entry preserved');
  for (const [event, sub] of [['SessionStart', 'session-start'], ['UserPromptSubmit', 'prompt'], ['PreToolUse', 'pre-tool']]) {
    const [entry] = graflyEntries(f.cfg, event);
    assert.ok(entry, event);
    assert.ok(entry.hooks[0].command.includes(`grafly-devin-hook.cjs" ${sub}`), entry.hooks[0].command);
    assert.ok(entry.hooks[0].command.includes('stdin-complete-run.cjs'));
  }
  assert.ok(existsSync(`${f.cfg}.grafly-bak`), 'undo copy kept');
});

test('reinstall replaces grafly entries in place instead of stacking', (t) => {
  const f = fixture(t);
  installDevinHooks(f.home);
  const again = installDevinHooks(f.home);
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse'])
    assert.equal(graflyEntries(f.cfg, event).length, 1, event);
  assert.equal(again.find((r) => r.id === 'devin-hooks').action, 'unchanged');
});

test('apply:false reports the drift without writing', (t) => {
  const f = fixture(t);
  installDevinHooks(f.home);
  writeFileSync(join(f.devin, 'hooks', 'grafly-devin-hook.cjs'), 'tampered');
  const cfgBefore = readFileSync(f.cfg, 'utf8');
  const bakBefore = readFileSync(`${f.cfg}.grafly-bak`, 'utf8');
  const plan = installDevinHooks(f.home, { apply: false });
  const byId = Object.fromEntries(plan.map((r) => [r.id, r.action]));
  assert.equal(byId['devin-hook-shim'], 'updated');
  assert.equal(byId['devin-hook-runner'], 'unchanged');
  assert.equal(byId['devin-hooks'], 'unchanged');
  assert.equal(readFileSync(join(f.devin, 'hooks', 'grafly-devin-hook.cjs'), 'utf8'), 'tampered');
  assert.equal(readFileSync(f.cfg, 'utf8'), cfgBefore);
  assert.equal(readFileSync(`${f.cfg}.grafly-bak`, 'utf8'), bakBefore, 'no backup rewrite on dry-run');
});

test('an unparseable config is left byte-identical', (t) => {
  const f = fixture(t, { config: false });
  writeFileSync(f.cfg, '{ not json');
  const results = installDevinHooks(f.home);
  assert.equal(results.find((r) => r.id === 'devin-hooks').action, 'skipped-unparseable');
  assert.equal(readFileSync(f.cfg, 'utf8'), '{ not json');
  assert.equal(existsSync(`${f.cfg}.grafly-bak`), false);
});

test('no Devin config dir means nothing to install', (t) => {
  const f = fixture(t, { config: false });
  rmSync(f.devin, { recursive: true, force: true });
  assert.deepEqual(devinHookTargets(f.home), []);
  assert.deepEqual(installDevinHooks(f.home), []);
});

test('install and retract retain a foreign safety hook inside a shared block', (t) => {
  const f = fixture(t);
  const guard = { type: 'command', command: 'node foreign-safety.cjs', timeout: 5 };
  const shared = { matcher: 'Write', hooks: [guard, { type: 'command', command: 'node grafly-devin-hook.cjs pre-tool' }] };
  writeFileSync(f.cfg, JSON.stringify({ theme_mode: 'dark', hooks: { PreToolUse: [shared] } }));
  installDevinHooks(f.home);
  let root = JSON.parse(readFileSync(f.cfg, 'utf8'));
  assert.deepEqual(root.hooks.PreToolUse[0], { ...shared, hooks: [guard] });
  const once = readFileSync(f.cfg, 'utf8');
  installDevinHooks(f.home);
  assert.equal(readFileSync(f.cfg, 'utf8'), once);
  const repo = join(f.home, 'repo'); mkdirSync(repo);
  const opts = { home: f.home, cache: false };
  for (const item of planRetract(repo, opts)) assert.ok(resolve(item.path).startsWith(resolve(f.home) + sep), item.path);
  runRetract(repo, opts);
  root = JSON.parse(readFileSync(f.cfg, 'utf8'));
  assert.deepEqual(root, { theme_mode: 'dark', hooks: { PreToolUse: [{ ...shared, hooks: [guard] }] } });
});
