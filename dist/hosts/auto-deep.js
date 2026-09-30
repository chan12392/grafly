// Explicitly opted-in background meaning builds, shared by host adapters.
// Retrieval and ordinary structural refresh remain offline.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync, utimesSync, realpathSync, linkSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import background from '../util/background.cjs';
import { fileURLToPath } from 'node:url';
import { acquireLockIn, releaseLockIn } from '../util/state.js';
import { contextDirFor } from '../context/node-file.js';
import { readFingerprint } from '../graph/fingerprint.js';
import { migrateIndex } from '../context/migrate-index.js';

const SELF = fileURLToPath(import.meta.url);
const HOUR = 3600000;
export const autoDeepHome = () => process.env.GRAFLY_AUTO_DEEP_HOME || join(homedir(), '.grafly');
const read = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
function write(file, value) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    renameSync(tmp, file);
}
function config(home) {
    const c = read(join(home, 'auto-deep.json'));
    if (c?.enabled !== true || !Array.isArray(c.roots) || !c.roots.length) return null;
    // This opt-in uses an existing keyless local proxy; no paid API fallback,
    // credential discovery, SSH provisioning, or remote-service changes.
    try {
        const url = new URL(c.baseUrl);
        if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password) return null;
    } catch { return null; }
    return { ...c, baseUrl: c.baseUrl.replace(/\/+$/, ''), concurrency: Math.min(5, Math.max(1, Number(c.concurrency) || 2)) };
}
function disabled() {
    return ['GRAFLY_NO_AUTO_INDEX', 'GRAFT_NO_AUTO_INDEX', 'GRAFLY_NO_AUTO_DEEP'].some(k => process.env[k] && !['0', 'false'].includes(process.env[k]));
}
function allowed(root, c) {
    return existsSync(join(root, '.git')) && c.roots.some(base => {
        try {
            const rel = relative(realpathSync(base), root);
            return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
        } catch { return false; }
    });
}
function paths(home, root) {
    const key = createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, 24);
    const dir = join(home, 'auto-deep');
    return { dir, queue: join(dir, 'queue'), job: join(dir, 'queue', `${key}.json`), state: join(dir, 'state', `${key}.json`) };
}
function wake(home) {
    const lock = read(join(home, 'auto-deep', '.sync.lock'));
    if (lock?.pid) {
        try { process.kill(lock.pid, 0); return; } catch {}
    }
    background.spawnBackground(process.execPath, [SELF, 'work'], {
        env: { ...process.env, GRAFLY_AUTO_DEEP_HOME: home },
    });
}
/** True means this project is managed, including an already queued/cached job. */
export function scheduleAutoDeep(root, { home = autoDeepHome(), launch = true, now = Date.now(), sessionId, force = false } = {}) {
    if (disabled()) return false;
    const c = config(home);
    if (!c) return false;
    try {
        root = realpathSync(root);
        if (!allowed(root, c)) return false;
        const p = paths(home, root);
        const previous = read(p.state);
        const session = sessionId ? createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 24) : null;
        if (session && previous?.completedSessions?.includes(session)) return true;
        if (session || force) p.job = p.job.replace(/\.json$/, `-${session || randomUUID()}.json`);
        if (!session && !force && !existsSync(p.job) && previous?.nextCheckAt > now) return true;
        mkdirSync(p.queue, { recursive: true });
        // Publish a complete record exclusively, so a worker cannot consume a
        // half-written job when two host hooks enqueue simultaneously.
        const temp = `${p.job}.${randomUUID()}.tmp`;
        writeFileSync(temp, JSON.stringify({ root, queuedAt: now, session }));
        try { linkSync(temp, p.job); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        finally { unlinkSync(temp); }
        if (launch) wake(home);
        return true;
    } catch { return false; }
}
export function autoDeepStatus(home = autoDeepHome()) {
    const dir = join(home, 'auto-deep');
    const list = folder => { try { return readdirSync(join(dir, folder)).filter(f => f.endsWith('.json')).map(f => read(join(dir, folder, f))).filter(Boolean); } catch { return []; } };
    return { enabled: !!config(home) && !disabled(), jobs: list('queue'), projects: list('state') };
}
function heartbeat(cache) {
    const timer = setInterval(() => { try { const now = new Date(); utimesSync(join(cache, '.sync.lock'), now, now); } catch {} }, 10000);
    timer.unref();
    return () => clearInterval(timer);
}
async function localModel(c) {
    const response = await fetch(`${c.baseUrl}/models`, { signal: AbortSignal.timeout(4000), redirect: 'error' });
    if (!response.ok) throw new Error(`model endpoint returned HTTP ${response.status}`);
    const ids = (await response.json()).data?.map(m => m.id).filter(id => typeof id === 'string') || [];
    const model = c.model || ids.find(id => /luna/i.test(id));
    if (!model || !ids.includes(model)) throw new Error('configured model is unavailable');
    return model;
}
/** Existing cached builders, with the concurrency limit applied to BOTH passes. */
export async function buildDeepProject(root, c, progress = () => {}) {
    migrateIndex(root);
    const [{ Grafly }, { buildContext, listContextFiles, CODE_EXTENSIONS }, { buildGraph }] = await Promise.all([
        import('../engine.js'), import('../context/build.js'), import('../graph/build.js'),
    ]);
    const contextDir = contextDirFor(root);
    const onlyDirs = readFingerprint(contextDir)?.onlyDirs;
    const cache = join(contextDir, '.cache');
    if (!acquireLockIn(cache)) return { status: 'busy' };
    const stopHeartbeat = heartbeat(cache);
    try {
        // Keep a usable structural index even when the endpoint is unavailable.
        progress({ phase: 'structure' });
        const structural = await buildGraph(root, { contextDir, graphOnly: true, onlyDirs });
        // Independent of query-refresh fingerprints: a query may have refreshed
        // structure since the last successful Deep pass. Hash the concept scope too.
        const identity = () => createHash('sha256').update(JSON.stringify({ version: 1,
            model: c.model, baseUrl: c.baseUrl, onlyDirs, fingerprint: readFingerprint(contextDir)?.extractor,
            files: listContextFiles(root, contextDir, CODE_EXTENSIONS, onlyDirs).sort().map(file =>
                [relative(root, file), createHash('sha256').update(readFileSync(file)).digest('hex')]),
        })).digest('hex');
        const before = identity();
        const stamp = join(cache, 'deepidx.json');
        const prior = read(stamp);
        const manifest = read(join(contextDir, 'manifest.json'));
        if (prior?.identity === before && manifest && manifest.nodes.every(n => existsSync(join(contextDir, `${n.slug}.md`))) &&
            !structural.errors.length && !structural.meaning.pending && !structural.meaning.stale)
            return { ...prior.result, cached: true };
        const model = await localModel(c);
        const engine = new Grafly({ provider: 'openai', apiKey: 'local', baseUrl: c.baseUrl, model, contextDir });
        progress({ phase: 'concepts', model });
        const concepts = await buildContext(root, {
            contextDir, model, concurrency: c.concurrency, onlyDirs,
            summarizer: engine.summarizer(), synthesizer: engine.synthesizer(), incremental: true,
        });
        // Fatal quota/auth failures must not start a second wave of requests.
        if (concepts.fatal) return { status: 'incomplete', model, conceptErrors: concepts.errors, fatal: concepts.fatal };
        progress({ phase: 'meaning', model });
        const graph = await engine.graph(root, { llm: true, concurrency: c.concurrency, onlyDirs });
        const m = graph.meaning;
        const conceptErrors = [...concepts.errors];
        if (concepts.files > 0 && concepts.nodes === 0) conceptErrors.push('No concept nodes were produced from nonempty source.');
        const changedDuringBuild = identity() !== before;
        if (changedDuringBuild) conceptErrors.push('Source changed during Deep; retry to finish the new revision.');
        const incomplete = conceptErrors.length || graph.errors.length || m.pending || m.stale || m.failedFiles || m.fatal;
        const result = { status: incomplete ? 'incomplete' : 'ready', model, nodes: graph.nodes, meaning: m, conceptErrors };
        if (!incomplete) write(stamp, { identity: before, result });
        return result;
    } finally { stopHeartbeat(); releaseLockIn(cache); }
}
/** One worker across hosts/projects. Queue files survive a worker crash. */
export async function runAutoDeepWorker({ home = autoDeepHome(), build = buildDeepProject } = {}) {
    let c = config(home);
    if (!c || disabled()) return;
    const dir = join(home, 'auto-deep');
    if (!acquireLockIn(dir)) return;
    const stopHeartbeat = heartbeat(dir);
    try {
        for (;;) {
            let files = [];
            try { files = readdirSync(join(dir, 'queue')).filter(f => f.endsWith('.json')); } catch {}
            if (!files.length || disabled() || !config(home)) break;
            for (const file of files) {
                c = config(home);
                if (!c || disabled()) return;
                const jobFile = join(dir, 'queue', file);
                const job = read(jobFile);
                if (!job?.root || !allowed(job.root, c)) { try { unlinkSync(jobFile); } catch {} continue; }
                const p = paths(home, job.root);
                const startedAt = Date.now();
                const completedSessions = read(p.state)?.completedSessions || [];
                const base = { root: job.root, startedAt, workerPid: process.pid, completedSessions };
                write(p.state, { ...base, status: 'running', phase: 'starting' });
                let result;
                try { result = await build(job.root, c, update => write(p.state, { ...base, status: 'running', ...update })); }
                catch (error) { result = { status: 'failed', error: error.message }; }
                const finishedAt = Date.now();
                if (result.status !== 'busy' && job.session) base.completedSessions = [...new Set([...completedSessions, job.session])].slice(-128);
                write(p.state, { ...base, ...result, finishedAt, nextCheckAt: finishedAt + (result.status === 'busy' ? 60000 : HOUR) });
                if (result.status === 'busy') await new Promise(resolve => setTimeout(resolve, 5000));
                else unlinkSync(jobFile);
            }
        }
    } finally {
        stopHeartbeat(); releaseLockIn(dir);
        // A hook can enqueue while the old worker is exiting; leave no lost wakeup.
        try { if (readdirSync(join(dir, 'queue')).some(f => f.endsWith('.json'))) wake(home); } catch {}
    }
}
/** Explicit CLI path, using the same configured local-only endpoint and root boundary. */
export async function deepidx(root, { background = false, sessionId, home = autoDeepHome() } = {}) {
    root = realpathSync(resolve(root));
    const c = config(home);
    if (disabled() || !c || !allowed(root, c))
        return { status: 'disabled', error: 'Enable .grafly/auto-deep.json with an allowed Git root and existing localhost endpoint.' };
    if (background) return { status: scheduleAutoDeep(root, { home, sessionId, force: true }) ? 'queued' : 'failed' };
    return buildDeepProject(root, c);
}
if (process.argv[1] && resolve(process.argv[1]) === SELF) {
    const command = process.argv[2];
    if (command === 'work') await runAutoDeepWorker();
    else if (command === 'status') console.log(JSON.stringify(autoDeepStatus(), null, 2));
    else if (command === 'enqueue') console.log(JSON.stringify({ managed: scheduleAutoDeep(process.argv[3] || process.cwd()) }));
}
