import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runUpgrade, formatUpgradeReport, isGitCheckout, packageRoot } from '../dist/cli-meta.js';
import { selfUpgradeDue } from '../scripts/grafly-devin-hook.cjs';

function pkgFixture(t, { git = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'grafly-selfup-'));
  t.after(() => {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'grafly', version: '9.9.9' }));
  if (git) mkdirSync(join(dir, '.git'));
  return { dir, url: pathToFileURL(join(dir, 'dist', 'cli.js')).href };
}

test('runUpgrade pulls when the package root is a git checkout', (t) => {
  const f = pkgFixture(t);
  const seen = [];
  const result = runUpgrade(f.url, { spawn: (cmd, args) => { seen.push([cmd, ...args]); return { status: 0, stdout: 'Already up to date.\n' }; } });
  assert.equal(result.ran, true);
  assert.equal(result.ok, true);
  assert.equal(result.source, 'git');
  assert.equal(result.pulled, false);
  assert.deepEqual(seen[0].slice(1), ['-C', f.dir, 'pull', '--ff-only']);
  assert.match(formatUpgradeReport(result), /already up to date/);
});

test('runUpgrade reports a failed pull instead of crashing', (t) => {
  const f = pkgFixture(t);
  const result = runUpgrade(f.url, { spawn: () => ({ status: 1, stderr: 'error: not possible to fast-forward\n' }) });
  assert.equal(result.ran, true);
  assert.equal(result.ok, false);
  assert.match(result.errorMessage, /fast-forward/);
  assert.match(formatUpgradeReport(result), /git pull --ff-only failed/);
});

test('a non-git package dir without GRAFLY_NPM_PACKAGE stays disabled', (t) => {
  const f = pkgFixture(t, { git: false });
  assert.equal(isGitCheckout(f.dir), false);
  assert.equal(packageRoot(f.url), f.dir);
  const result = runUpgrade(f.url);
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'unconfigured');
  assert.match(formatUpgradeReport(result), /no git checkout or GRAFLY_NPM_PACKAGE/);
});

test('selfUpgradeDue gates the daily probe on the stamp', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'grafly-stamp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stamp = join(dir, 'self-upgrade.stamp');
  assert.equal(selfUpgradeDue(stamp), true, 'no stamp → due');
  writeFileSync(stamp, 'x');
  assert.equal(selfUpgradeDue(stamp), false, 'fresh stamp → not due');
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  utimesSync(stamp, old, old);
  assert.equal(selfUpgradeDue(stamp), true, 'stale stamp → due');
});
