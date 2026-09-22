#!/usr/bin/env node
import { readConfig, runtimeHome, syncRuntime, runtimeStatus, atomicWrite, acquireLock } from './runtime.js';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export async function watchRuntime(home = runtimeHome()) {
  const unlock = acquireLock(home, 'watch.lock');
  if (!unlock) return;
  const config = readConfig(home);
  if (!config) { unlock(); throw new Error('mc_not_configured'); }
  const stop = new AbortController();
  const shutdown = () => stop.abort();
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  const sync = async () => {
    try {
      const result = await syncRuntime(home);
      if (result.status === 'updated') console.log(JSON.stringify(result));
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
    process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown); unlock();
  }
}

export async function runtimeCLI(action = 'status') {
  if (action === 'watch') return watchRuntime();
  if (!['status', 'sync'].includes(action)) throw new Error('Use mc-runtime status|sync|watch');
  console.log(JSON.stringify(action === 'sync' ? await syncRuntime() : runtimeStatus(), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runtimeCLI(process.argv[2]).catch(error => {
    console.error(/^mc_[a-z_]+$/.test(error.message) ? error.message : 'mc_runtime_failed'); process.exitCode = 1;
  });
}
