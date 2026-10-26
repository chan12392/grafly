import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { mcConfig, judgeOneSite } from './escalate.js';

export function analyzerAction(action, opts = {}) {
    const path = process.env.GRAFLY_MC_CONFIG || join(homedir(), '.grafly', 'mc-analyzer.json');
    if (action === 'configure') {
        if (!opts.home || !opts.python) throw new Error('--home and --python are required');
        const home = resolve(opts.home), python = resolve(opts.python);
        if (!existsSync(join(home, 'morecoffee', 'channels', 'code_relation_stdio.py'))
            || !existsSync(python) || !statSync(python).isFile()) throw new Error('MC channel/interpreter not found');
        mkdirSync(dirname(path), { recursive: true });
        if (existsSync(path)) writeFileSync(path + '.' + Date.now() + '.bak', readFileSync(path), { flag: 'wx', mode: 0o600 });
        writeFileSync(path, JSON.stringify({ schema: 'grafly.mc-analyzer.v1', enabled: true, home, python }, null, 2) + '\n', { mode: 0o600 });
    }
    const root = resolve(opts.root || '.');
    const cfg = mcConfig(root);
    if (['status', 'configure'].includes(action)) return { enabled: Boolean(cfg), ...(cfg || {}), config: path };
    if (action !== 'judge') throw new Error('use status, configure, or judge');
    if (!cfg) throw new Error('MC analyzer is not configured');
    if (!opts.file || !opts.candidate?.length) throw new Error('--file and --candidate path#symbol are required');
    const candidates = opts.candidate.map(id => {
        const split = id.lastIndexOf('#');
        if (split < 1 || split === id.length - 1) throw new Error('candidate must be path#symbol');
        return { id, file: id.slice(0, split), name: id.slice(split + 1) };
    });
    return { tool: 'mc.code_relation', analyzer_source: cfg.source, ...judgeOneSite(cfg, root, opts.file, candidates) };
}
