#!/usr/bin/env node
import { readConfig, runtimeHome, syncRuntime, runtimeStatus, atomicWrite, acquireLock, resolveRuntime } from './runtime.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startArchiveMaintenance } from '../tool-output/retention.js';
import { syncModels, modelStatus } from './models.js';

export async function runLearning(action = 'status', home = runtimeHome()) {
  if (action !== 'status') throw new Error('mc_learning_mc_owned');
  const resolved = resolveRuntime(home);
  if (resolved.status !== 'ok' || resolved.metadata.runtime_api < 5) return { status: 'unavailable', reason: 'mc_learning_runtime_unavailable' };
  const code = "import sys,runpy; root=sys.argv.pop(1); sys.path.insert(0,root); runpy.run_module('morecoffee.learning_service',run_name='__main__')";
  const { stdout } = await promisify(execFile)(resolved.python, ['-I', '-S', '-B', '-X', 'utf8', '-c', code, resolved.root, action],
    { windowsHide: true, timeout: 20000, maxBuffer: 65536, cwd: resolved.root });
  return JSON.parse(stdout);
}

export async function syncUpdates(home = runtimeHome(), { transport = fetch, modelsHome } = {}) {
  const code = syncRuntime(home, { transport }).catch(error => {
    const result = { status: 'retrying', reason: /^mc_[a-z_]+$/.test(error.message) ? error.message : 'mc_update_failed', checked_at: new Date().toISOString() };
    atomicWrite(join(home, 'status.json'), JSON.stringify(result));
    return result;
  });
  const models = syncModels(home, { transport, ...(modelsHome ? { home: modelsHome } : {}) }).catch(error => ({
    status: 'retrying', reason: /^mc_[a-z_]+$/.test(error.message) ? error.message : 'mc_model_update_failed',
  }));
  const [result, modelResult] = await Promise.all([code, models]);
  return { ...result, models: modelResult };
}

export async function watchRuntime(home = runtimeHome()) {
  const unlock = acquireLock(home, 'watch.lock');
  if (!unlock) return;
  const config = readConfig(home);
  if (!config) { unlock(); throw new Error('mc_not_configured'); }
  // Independent of the network connection; reap crashed/finished writers while idle.
  const stopMaintenance = startArchiveMaintenance();
  const stop = new AbortController();
  const shutdown = () => stop.abort();
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  const sync = async () => {
    try {
      const result = await syncUpdates(home);
      if (result.status === 'updated' || result.models.status === 'updated') console.log(JSON.stringify(result));
    } catch (error) {
      atomicWrite(join(home, 'status.json'), JSON.stringify({ status: 'retrying',
        reason: /^mc_[a-z_]+$/.test(error.message) ? error.message : 'mc_update_failed', checked_at: new Date().toISOString() }));
    }
  };
  try {
    while (!stop.signal.aborted) {
      await sync();
      let interval;
      const streamStop = new AbortController();
      const abort = () => streamStop.abort();
      stop.signal.addEventListener('abort', abort, { once: true });
      // Also reconnect periodically; a silently dropped notification cannot freeze updates.
      const deadline = setTimeout(abort, 5 * 60 * 1000);
      try {
        const response = await fetch(config.url + '/v1/events', { redirect: 'error', signal: streamStop.signal,
          headers: { Authorization: `Bearer ${config.token}`, Accept: 'text/event-stream' } });
        if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream')) throw new Error('mc_event_status');
        interval = setInterval(() => void sync(), 60000);
        let pending = '';
        for await (const chunk of response.body) {
          pending += new TextDecoder().decode(chunk);
          if (pending.length > 16384) throw new Error('mc_event_size');
          let end;
          while ((end = pending.indexOf('\n\n')) >= 0) {
            const event = pending.slice(0, end); pending = pending.slice(end + 2);
            if (/^event: (ready|release)$/m.test(event)) await sync();
          }
        }
      } catch { /* reconnect; keep the verified active version */ }
      finally { clearTimeout(deadline); clearInterval(interval); stop.signal.removeEventListener('abort', abort); }
      if (!stop.signal.aborted) await delay(5000 + Math.random() * 5000, undefined, { signal: stop.signal }).catch(() => {});
    }
  } finally {
    stopMaintenance();
    process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown); unlock();
  }
}

export async function runtimeCLI(action = 'status') {
  if (action === 'watch') return watchRuntime();
  if (action === 'resolve') {
    const result = resolveRuntime();
    console.log(JSON.stringify(result));
    if (result.status !== 'ok') process.exitCode = 1;
    return;
  }
  if (action.startsWith('learning-')) {
    console.log(JSON.stringify(await runLearning(action.slice('learning-'.length))));
    return;
  }
  if (!['status', 'sync'].includes(action)) throw new Error('Use mc-runtime status|sync|watch');
  const result = action === 'sync' ? await syncUpdates() : { ...runtimeStatus(), models: modelStatus() };
  console.log(JSON.stringify(result, null, 2));
  if (action === 'sync' && (result.status === 'retrying' || result.models.status === 'retrying')) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runtimeCLI(process.argv[2]).catch(error => {
    console.error(/^mc_[a-z_]+$/.test(error.message) ? error.message : 'mc_runtime_failed'); process.exitCode = 1;
  });
}
