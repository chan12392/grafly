import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { devinHookTargets, installDevinHooks } from '../dist/hosts/devin-hooks.js';

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

test('on Windows the config Devin loads (%APPDATA%/devin) wins over a leftover ~/.config/devin', { skip: process.platform !== 'win32' }, (t) => {
  const home = mkdtempSync(join(tmpdir(), 'grafly-devin-appdata-'));
  const appData = join(home, 'AppData', 'Roaming');
  const saved = process.env.APPDATA;
  t.after(() => {
    assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep));
    rmSync(home, { recursive: true, force: true });
    if (saved === undefined) delete process.env.APPDATA; else process.env.APPDATA = saved;
  });
  delete process.env.GRAFLY_DEVIN_DIR;
  process.env.APPDATA = appData;
  for (const dir of [join(home, '.config', 'devin'), join(appData, 'devin')]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ hooks: {} }));
  }
  installDevinHooks(home);
  assert.equal(graflyEntries(join(appData, 'devin', 'config.json'), 'UserPromptSubmit').length, 1);
  assert.equal(graflyEntries(join(home, '.config', 'devin', 'config.json'), 'UserPromptSubmit').length, 0);
});

test('an alternate home never reaches the account %APPDATA% Devin config', { skip: process.platform !== 'win32' }, (t) => {
  const account = mkdtempSync(join(tmpdir(), 'grafly-devin-account-'));
  const home = mkdtempSync(join(tmpdir(), 'grafly-devin-alt-home-'));
  const saved = process.env.APPDATA;
  t.after(() => {
    for (const dir of [account, home]) {
      assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
      rmSync(dir, { recursive: true, force: true });
    }
    if (saved === undefined) delete process.env.APPDATA; else process.env.APPDATA = saved;
  });
  delete process.env.GRAFLY_DEVIN_DIR;
  // Stands in for the signed-in user's %APPDATA%: install/retract for another home must not reach it.
  process.env.APPDATA = account;
  mkdirSync(join(account, 'devin'), { recursive: true });
  writeFileSync(join(account, 'devin', 'config.json'), JSON.stringify({ hooks: {} }));
  mkdirSync(join(home, '.config', 'devin'), { recursive: true });
  writeFileSync(join(home, '.config', 'devin', 'config.json'), JSON.stringify({ hooks: {} }));
  assert.ok(devinHookTargets(home).every((target) => !resolve(target.path).startsWith(resolve(account) + sep)));
  installDevinHooks(home);
  assert.equal(readFileSync(join(account, 'devin', 'config.json'), 'utf8'), JSON.stringify({ hooks: {} }));
});
