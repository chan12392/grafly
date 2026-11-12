/** Optional local-broker producer. MC/JEV judgments never alter the original operation. */
import { readFileSync, existsSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';

const read = path => {
    if (statSync(path).size > 65536) throw new Error('comparison_configuration_size');
    return JSON.parse(readFileSync(path, 'utf8'));
};
const privateText = text => /(?:["']?(?:authorization|api[_-]?key|(?:access|refresh|oauth)[_-]?token|password|client[_-]key[_-]data)["']?\s*[:=]\s*["']?(?:Bearer\s+)?\S{8,}|["']--?(?:password|api-key|token|secret)["']\s*,|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-|eyJ)[\w.-]{24,}|\bpassword\s+\S{8,}|https?:\/\/[^\s/@]+:[^\s/@]+@)/i.test(text);

export async function observeComparison(event, { cwd = process.cwd(), sessionId, env = process.env } = {}) {
    if (env.GRAFLY_JUDGMENT_CONFIG === '0') return { status: 'disabled' };
    const file = env.GRAFLY_JUDGMENT_CONFIG || join(homedir(), '.grafly', 'comparison.json');
    if (!existsSync(file)) return { status: 'disabled' };
    const save = result => {
        try {
            const dest = join(dirname(file), 'comparison-status.json'), temp = dest + '.' + randomUUID();
            writeFileSync(temp, JSON.stringify({ ...result, checked_at: new Date().toISOString() }), { mode: 0o600 });
            renameSync(temp, dest);
        } catch { /* Observability cannot break the original operation. */ }
        return result;
    };
    try {
        const identity = sessionId ?? env.CODEX_THREAD_ID ?? env.GRAFLY_SESSION_ID;
        if (typeof identity !== 'string' || !identity.trim()) return save({ status: 'skipped', reason: 'active_session_unavailable' });
        const text = JSON.stringify(event);
        if (Buffer.byteLength(text) > 64000 || privateText(text) || !Array.isArray(event.items)
            || event.items.some(item => typeof item.text !== 'string' || privateText(item.text)))
            return save({ status: 'skipped', reason: 'input_size_or_private_material' });
        const config = read(file);
        if (config.schema !== 'grafly.comparison.v1' || config.enabled !== true
            || !['python', 'service_root', 'runtime_root', 'state_root'].every(k => typeof config[k] === 'string' && isAbsolute(config[k])))
            return save({ status: 'unavailable', reason: 'invalid_configuration' });
        const settingsFile = join(config.state_root, 'model-access', 'settings.json');
        const settings = existsSync(settingsFile) ? read(settingsFile) : { mode: 'basic' };
        if (!['jev', 'both'].includes(settings.mode)) return save({ status: 'disabled', reason: 'model_mode' });
        const state = read(join(config.runtime_root, 'state.json'));
        if (typeof state.active !== 'string' || !/^[a-f0-9]{40}$/.test(state.active)) throw new Error('invalid_runtime');
        const source = join(config.runtime_root, 'releases', state.active);
        if (!existsSync(join(source, 'src', 'beakho_harness', 'mc_comparison.py'))) throw new Error('comparison_runtime_unavailable');
        const meta = read(join(config.service_root, 'service.json'));
        if (meta.state !== 'running' || meta.protocol !== 1 || !meta.capabilities?.includes('background-jobs-v1')
            || !Number.isInteger(meta.port) || meta.port < 1 || meta.port > 65535 || typeof meta.token !== 'string' || !meta.token)
            throw new Error('comparison_broker_unavailable');
        const argv = ['--root', config.state_root, 'compare', 'observe', '--cwd', resolve(cwd), '--session-id', identity, '--request-stdin'];
        const body = JSON.stringify({ argv, stdin: JSON.stringify({ ...event, source: 'grafly' }),
            cwd: resolve(cwd), source, python: config.python });
        return await new Promise(complete => {
            let finished = false;
            const done = result => { if (!finished) { finished = true; clearTimeout(deadline); complete(save(result)); } };
            const req = request({ hostname: '127.0.0.1', port: meta.port, path: '/submit', method: 'POST',
                headers: { Authorization: 'Bearer ' + meta.token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
                let response = '';
                res.setEncoding('utf8');
                res.on('data', chunk => { response += chunk; if (response.length > 65536) req.destroy(); });
                res.on('end', () => {
                    try {
                        const result = JSON.parse(response);
                        done(res.statusCode === 200 && result.status === 'queued' && /^[a-f0-9]{32}$/.test(result.job_id)
                            ? { status: 'queued', job_id: result.job_id }
                            : { status: 'skipped', reason: 'broker_rejected' });
                    } catch { done({ status: 'unavailable', reason: 'invalid_broker_response' }); }
                });
                res.on('error', () => done({ status: 'unavailable', reason: 'broker_response_failed' }));
            });
            const deadline = setTimeout(() => req.destroy(), 750);
            req.on('error', () => done({ status: 'unavailable', reason: 'broker_unavailable' }));
            req.end(body);
        });
    } catch { return save({ status: 'unavailable', reason: 'comparison_unavailable' }); }
}

export function outputItems(stdout, stderr, failed = false) {
    const items = [];
    for (const [name, text] of [['stdout', stdout], ['stderr', stderr]]) {
        const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
        const width = Math.max(1, Math.ceil(lines.length / 16));
        for (let start = 0; start < lines.length; start += width)
            items.push({ id: `${name}:${start + 1}`, text: lines.slice(start, start + width).join(''),
                protected: failed || name === 'stderr', constraint_status: 'unknown',
                ...(failed ? { role: 'failure' } : {}) });
    }
    return items;
}
