/** Export bounded features and externally reviewed outcomes to the local MC loop. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { FEATURE_KEYS } from '../circuit/mc-channel.js';

const hash = text => createHash('sha256').update(text).digest('hex');
export function collectJudgment(judgment, label = null, env = process.env) {
    const home = env.MC_LEARNING_HOME || join(homedir(), '.morecoffee', 'learning');
    try {
        if (!isAbsolute(home) || !existsSync(home) || lstatSync(home).isSymbolicLink()) return false;
        const configPath = join(home, 'config.json'), stat = lstatSync(configPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return false;
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        if (config.schema !== 'mc.learning.config.v1' || config.enabled !== true) return false;
        if (!Array.isArray(judgment?.features) || judgment.features.length < 2 || judgment.features.length > 64
            || typeof judgment.root !== 'string' || typeof judgment.query !== 'string') return false;
        const candidates = judgment.features.map(f => {
            if (typeof f.id !== 'string' || !f.id || FEATURE_KEYS.some(k => typeof f[k] !== 'number' || !Number.isFinite(f[k]) || f[k] < 0 || f[k] > 1)) throw new Error('invalid_features');
            return { id: hash(f.id), features: Object.fromEntries(FEATURE_KEYS.map(k => [k, f[k]])) };
        }).sort((a, b) => a.id.localeCompare(b.id));
        if (new Set(candidates.map(c => c.id)).size !== candidates.length) return false;
        let outcome = null;
        if (label) {
            if (label.source !== 'explicit' || typeof label.evidence !== 'string' || !label.evidence.trim()) return false;
            const expected = label.expected === 'abstain' ? 'abstain' : hash(label.expected);
            if (expected !== 'abstain' && !candidates.some(c => c.id === expected)) return false;
            outcome = { label: expected, method: 'explicit_review', evidence_sha256: hash(JSON.stringify({ jid: judgment.jid, expected, evidence: label.evidence })) };
        }
        const record = { schema: 'mc.feedback.v1', source: 'grafly', task: 'symbol_disambiguation',
            group_id: hash(JSON.stringify([judgment.root, judgment.query.trim().toLowerCase()])), candidates, outcome };
        const bytes = Buffer.from(JSON.stringify(record));
        if (bytes.length > 65536) return false;
        const inbox = join(home, 'inbox');
        mkdirSync(inbox, { recursive: true, mode: 0o700 });
        if (lstatSync(inbox).isSymbolicLink() || readdirSync(inbox).length >= 10000) throw new Error('inbox_limit');
        const destination = join(inbox, hash(bytes) + '.json'), temporary = join(inbox, randomUUID() + '.tmp');
        writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
        renameSync(temporary, destination);
        return true;
    } catch {
        // Collection must not change a command or an explicit review's outcome.
        try { writeFileSync(join(home, 'collection-status.json'), JSON.stringify({ status: 'failed', reason: 'mc_feedback_collection_failed', checked_at: new Date().toISOString() }), { mode: 0o600 }); } catch {}
        return false;
    }
}
