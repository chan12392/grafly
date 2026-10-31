import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { claudeDistDir, userHooksDistDir } from '../dist/claude/paths.js';
import { devinShimSource } from '../dist/hosts/devin-hooks.js';

test('user-level hook shims follow the global install, not the checkout running the installer', { skip: process.platform !== 'win32' }, (t) => {
  const appData = mkdtempSync(join(tmpdir(), 'grafly-global-'));
  const saved = process.env.APPDATA;
  t.after(() => {
    assert.ok(resolve(appData).startsWith(resolve(tmpdir()) + sep));
    rmSync(appData, { recursive: true, force: true });
    if (saved === undefined) delete process.env.APPDATA; else process.env.APPDATA = saved;
  });
  process.env.APPDATA = appData;
  // No global install: this package bakes itself in.
  assert.equal(userHooksDistDir(), claudeDistDir());
  // A different global install exists: a review or temporary checkout must not repoint the hooks.
  const globalDist = join(appData, 'npm', 'node_modules', 'grafly', 'dist');
  mkdirSync(join(globalDist, 'claude'), { recursive: true });
  writeFileSync(join(globalDist, 'claude', 'hooks.js'), '');
  assert.equal(userHooksDistDir(), join(globalDist, 'claude'));
  assert.match(devinShimSource(), new RegExp(`const INSTALLED_DIST = ${JSON.stringify(globalDist).replaceAll('\\', '\\\\')};`));
});
