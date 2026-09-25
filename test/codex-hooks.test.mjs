import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
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
