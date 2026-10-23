import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('hidden updater launcher retains streams and exit status while recovering a failed child',
  { skip: !process.env.GRAFLY_TEST_PYTHON }, t => {
  const home = mkdtempSync(join(tmpdir(), 'grafly-updater-launcher-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const marker = join(home, 'started');
  const child = `const fs=require('node:fs'); const path=process.argv[1]; const retry=fs.existsSync(path); fs.writeFileSync(path,'started'); console.log(retry?'recovered':'first'); console.error('retained diagnostic'); process.exit(retry?0:1);`;
  const result = spawnSync(process.env.GRAFLY_TEST_PYTHON,
    [fileURLToPath(new URL('../dist/mc-runtime/launcher.py', import.meta.url)), process.execPath, '-e', child, marker],
    { env: { ...process.env, GRAFLY_MC_RUNTIME_HOME: home }, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const output = readFileSync(join(home, 'watcher.stdout.log'), 'utf8');
  assert.match(output, /first[\s\S]*mc watcher exit=1[\s\S]*recovered[\s\S]*mc watcher exit=0/);
  assert.match(readFileSync(join(home, 'watcher.stderr.log'), 'utf8'), /retained diagnostic/);
});
