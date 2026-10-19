import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hookTargets, installCodexHooks } from '../dist/hosts/codex-hooks.js';

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
  for (const [event, file, sub, timeout] of [
    ['SessionStart', 'grafly-devin-hook.cjs', 'session-start', 10],
    ['UserPromptSubmit', 'grafly-devin-hook.cjs', 'prompt', 15],
    ['PostToolUse', 'grafly-hooks.cjs', 'post-edit', 10],
    ['Stop', 'grafly-hooks.cjs', 'stop', 10],
  ]) {
    const [entry] = ours(f.cfg, event, file);
    assert.ok(entry, `${event} -> ${file}`);
    assert.ok(entry.hooks[0].command.includes(`${file}" ${sub}`), entry.hooks[0].command);
    assert.equal(entry.hooks[0].timeout, timeout, `${event} timeout uses seconds`);
  }
  const cfg = JSON.parse(readFileSync(f.cfg, 'utf8'));
  assert.equal(cfg.hooks.SessionStart.length, 2, 'foreign SessionStart entry preserved');
});

test('upgrade corrects legacy timeouts and reinstall preserves the corrected settings', (t) => {
  const f = fixture(t);
  installCodexHooks(f.home);
  const expected = JSON.parse(readFileSync(f.cfg, 'utf8'));
  expected.hooks.Stop.unshift({ hooks: [] });
  const legacy = structuredClone(expected);
  for (const [event, timeout] of Object.entries({ SessionStart: 10, UserPromptSubmit: 15, PostToolUse: 10, Stop: 10 })) {
    const index = legacy.hooks[event].findIndex((entry) => /grafly-(devin-)?hooks?\.cjs/.test(JSON.stringify(entry)));
    expected.hooks[event][index].hooks[0].timeout = timeout;
    legacy.hooks[event][index].hooks[0].timeout = timeout * 1000;
  }
  writeFileSync(f.cfg, JSON.stringify(legacy, null, 2));
  const before = readFileSync(f.cfg, 'utf8');
  const plan = installCodexHooks(f.home, { apply: false });
  assert.equal(plan.find((r) => r.id === 'codex-hooks').action, 'updated');
  assert.equal(readFileSync(f.cfg, 'utf8'), before, 'dry-run preserves legacy settings');
  const upgrade = installCodexHooks(f.home);
  assert.equal(upgrade.find((r) => r.id === 'codex-hooks').action, 'updated');
  assert.deepEqual(JSON.parse(readFileSync(f.cfg, 'utf8')), expected, 'only owned timeouts change');
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

test('account reinstall updates shared shims without changing trusted definitions or retracting shared files', (t) => {
  const f = fixture(t);
  installCodexHooks(f.home);
  const account = join(f.home, 'account');
  const repo = join(f.home, 'repo');
  mkdirSync(account);
  mkdirSync(repo);
  const before = readFileSync(f.cfg, 'utf8');
  writeFileSync(join(account, 'hooks.json'), before);
  const sharedAgent = join(f.dir, 'grafly-devin-hook.cjs');
  writeFileSync(sharedAgent, 'old generated shim');
  const installer = new URL('../dist/hosts/codex-hooks.js', import.meta.url).href;
  const retractor = new URL('../dist/hosts/retract.js', import.meta.url).href;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { hookTargets, installCodexHooks } from ${JSON.stringify(installer)};
    import { planRetract } from ${JSON.stringify(retractor)};
    import { readFileSync } from 'node:fs';
    const targets = hookTargets();
    const plan = installCodexHooks(undefined, { apply: false });
    const beforeApply = readFileSync(${JSON.stringify(sharedAgent)}, 'utf8');
    const applied = installCodexHooks();
    const again = installCodexHooks();
    const retract = planRetract(${JSON.stringify(repo)});
    console.log(JSON.stringify({ targets, plan, beforeApply, applied, again, retract }));
  `], {
    env: { ...process.env, HOME: f.home, USERPROFILE: f.home, CODEX_HOME: account },
    encoding: 'utf8', windowsHide: true,
  }));
  assert.equal(readFileSync(join(account, 'hooks.json'), 'utf8'), before, 'command paths, metadata and slots stay identical');
  assert.equal(readFileSync(f.cfg, 'utf8'), before, 'default home config stays untouched');
  assert.equal(result.targets[0].path, join(f.dir, 'grafly-hooks.cjs'));
  assert.equal(result.targets[1].path, sharedAgent);
  assert.equal(result.beforeApply, 'old generated shim', 'planning performs no write');
  assert.match(readFileSync(sharedAgent, 'utf8'), /autoBuildRoot/, 'the registered shared shim is refreshed');
  assert.equal(existsSync(join(account, 'hooks')), false, 'no unused account shim copies');
  assert.equal(result.plan.find((r) => r.id === 'codex-hooks').action, 'unchanged');
  assert.equal(result.applied.find((r) => r.id === 'codex-hooks').action, 'unchanged');
  assert.ok(result.again.every((r) => r.action === 'unchanged'));
  assert.ok(result.retract.some((r) => r.path === join(account, 'hooks.json')));
  assert.ok(result.retract.every((r) => ![sharedAgent, join(f.dir, 'grafly-hooks.cjs')].includes(r.path)), 'account retraction leaves shared files owned by the default home');
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
