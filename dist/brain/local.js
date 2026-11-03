import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheDir, readBuildConfig, readJson, writeJsonAtomic } from '../util/state.js';
import { acquireProcessLock } from '../util/process-lock.js';
import { brainIdentity, readLink, readRulesCache, rulesCachePath, withBrainLock, writeLink, writeRulesCache } from './link.js';
import { rewriteBrainSections } from './note.js';

export const MINING_INTERVAL_MS = 6 * 60 * 60 * 1000;
const statePath = repo => join(cacheDir(repo), 'brain-worker.json');
const saveState = (repo, state) => writeJsonAtomic(statePath(repo), state, true);
export const localBrainState = repo => readJson(statePath(repo));

/** Explicit migration preserves the stored connection's rules, never an environment override's. */
export function configureLocalBrain(repo, { background, contextDir } = {}) {
    return withBrainLock(repo, () => {
        const stored = readBuildConfig(repo)?.brain;
        const cache = stored ? readRulesCache(repo, stored) : readJson(rulesCachePath(repo));
        if (existsSync(rulesCachePath(repo)) && (!cache || !Array.isArray(cache.rules)))
            throw new Error('Existing Brain rules could not be read for migration; the cache was preserved.');
        const link = { ...(stored?.local ? stored : { brainId: 'local', token: 'local', local: true }),
            background: background ?? stored?.background ?? false,
            ...(contextDir !== undefined ? { contextDir } : {}) };
        if (!stored?.local || stored.background !== link.background || stored.contextDir !== link.contextDir) {
            writeLink(repo, link);
            writeRulesCache(repo, { ...cache, brainId: link.brainId, fetchedAt: cache?.fetchedAt ?? 0,
                refreshId: undefined, rules: cache?.rules ?? [] }, link);
            saveState(repo, { ...localBrainState(repo), status: link.background ? 'idle' : 'disabled',
                runId: undefined, checkedAt: 0, pid: undefined });
        }
        return { link, ruleCount: cache?.rules.length ?? 0, migrated: !!stored && !stored.local };
    });
}

/** The foreground only schedules; model calls and digest reads happen in the child. */
export function scheduleLocalBrain(repo, now = Date.now()) {
    if (process.env.GRAFLY_READONLY === '1' || process.env.GRAFLY_NO_BRAIN === '1') return false;
    try {
        if (!readLink(repo)?.local || !readLink(repo)?.background) return false;
        return withBrainLock(repo, () => {
            const link = readLink(repo), previous = localBrainState(repo);
            if (!link?.local || !link.background || now - (previous?.checkedAt ?? 0) < MINING_INTERVAL_MS) return false;
            const runId = randomUUID();
            const log = join(cacheDir(repo), 'brain-worker.log');
            const fd = openSync(log, 'w', 0o600);
            try {
                saveState(repo, { ...previous, status: 'queued', runId, checkedAt: now, log });
                const child = spawn(process.execPath, [fileURLToPath(new URL('../cli.js', import.meta.url)),
                    '_brain-refresh', resolve(repo), '--job', runId], {
                    cwd: resolve(repo), detached: true, windowsHide: true, stdio: ['ignore', fd, fd],
                });
                child.once('error', error => {
                    try {
                        withBrainLock(repo, () => {
                            const state = localBrainState(repo);
                            if (state?.runId === runId) saveState(repo, { ...state, status: 'error',
                                error: error.message.slice(0, 500), exitCode: 1, pid: undefined });
                        });
                    } catch { /* A later scheduled attempt can retry. */ }
                });
                saveState(repo, { ...localBrainState(repo), pid: child.pid });
                child.unref();
                return true;
            } finally { closeSync(fd); }
        });
    } catch { return false; }
}

/** One bounded digest pass; the process lock spans the model call, the state lock does not. */
export async function mineLocalBrain(repo, { background = false, jobId, home = homedir(), model, contextDir } = {}) {
    if (process.env.GRAFLY_READONLY === '1' || (background && process.env.GRAFLY_NO_BRAIN === '1'))
        return { status: 'disabled' };
    if (!background) configureLocalBrain(repo, { contextDir });
    const link = readLink(repo);
    if (!link?.local || (background && !link.background)) return { status: 'disabled' };
    const release = acquireProcessLock(join(cacheDir(repo), 'brain-mining.lock'));
    if (!release) return { status: 'busy' };
    const runId = jobId ?? randomUUID();
    const finish = (status, extra = {}) => withBrainLock(repo, () => {
        const state = localBrainState(repo);
        if (state?.runId !== runId || brainIdentity(readLink(repo)) !== brainIdentity(link)) return { status: 'discarded' };
        const result = { ...state, status, completedAt: Date.now(), pid: undefined,
            exitCode: status === 'error' || status === 'needs-model' ? 1 : 0, ...extra };
        saveState(repo, result);
        return result;
    });
    try {
        const started = withBrainLock(repo, () => {
            const state = localBrainState(repo);
            if (jobId && state?.runId !== jobId) return false;
            if (brainIdentity(readLink(repo)) !== brainIdentity(link) || (background && !readLink(repo)?.background)) return false;
            saveState(repo, { ...state, status: 'running', runId, checkedAt: Date.now(), startedAt: Date.now(),
                pid: process.pid, error: undefined, exitCode: undefined });
            return true;
        });
        if (!started) return { status: 'discarded' };
        const { contextDirFor } = await import('../context/node-file.js');
        const { loadGraphCached } = await import('../graph/load.js');
        const { buildLocalDigest } = await import('./push.js');
        const graph = loadGraphCached(contextDirFor(repo, contextDir ?? link.contextDir));
        if (!graph?.nodes.length) throw new Error('No graph to anchor rules; run grafly build first.');
        const built = await buildLocalDigest(repo, graph);
        if ('error' in built) throw new Error(built.error);
        const inputHash = createHash('sha256').update(JSON.stringify(built.digest)).digest('hex');
        if (background && localBrainState(repo)?.inputHash === inputHash) return finish('unchanged');
        if (!model) {
            const { resolveConfig, ambientLlmConfig } = await import('../ai/providers.js');
            const { createChatModel } = await import('../ai/llm/factory.js');
            let config = resolveConfig();
            if (!config.apiKey) config = ambientLlmConfig({ ...process.env,
                GRAFLY_AMBIENT_URL: config.baseUrl ?? process.env.GRAFLY_AMBIENT_URL });
            if (!config) return finish('needs-model', { error: 'Configure a local model endpoint or GRAFLY_API_KEY, then run grafly brain mine.' });
            model = createChatModel(config);
        }
        const { mineRules } = await import('../../service/brain-mining.mjs');
        const mined = await mineRules(built.digest, model);
        return withBrainLock(repo, () => {
            if (localBrainState(repo)?.runId !== runId || brainIdentity(readLink(repo)) !== brainIdentity(link)) return { status: 'discarded' };
            const cache = readRulesCache(repo, link) ?? { brainId: link.brainId, fetchedAt: 0, rules: [] };
            const rules = [...cache.rules];
            let added = 0;
            for (const rule of mined) {
                const normalized = { ruleId: rule.rule_id, symbol: rule.symbol, fingerprint: rule.fingerprint,
                    rule: rule.rule, sourceUrl: rule.source_url };
                const existing = rules.findIndex(r => r.symbol === rule.symbol && r.rule.trim() === rule.rule);
                if (existing < 0) { rules.push(normalized); added++; }
                else if (rules[existing].ruleId === rule.rule_id) rules[existing] = normalized;
            }
            writeRulesCache(repo, { ...cache, fetchedAt: Date.now(), rules }, link);
            rewriteBrainSections(repo, home);
            return finish('complete', { inputHash, added, total: rules.length, lastSuccessAt: Date.now() });
        });
    } catch (error) {
        return finish('error', { error: String(error.message ?? error).slice(0, 500) });
    } finally { release(); }
}
