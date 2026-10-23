// Canonical MoreCoffee portable channel. Consumers generate copies, never fork rules.
import { readFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
export const ARTIFACT = JSON.parse(readFileSync(new URL('./symbol_disambiguation.json', import.meta.url), 'utf8'));
export const FEATURE_KEYS = Object.freeze(Object.keys(ARTIFACT.weights));
function localModel() {
    try {
        const home = process.env.MC_MODEL_HOME || join(homedir(), '.morecoffee', 'models');
        const learningHome = process.env.MC_LEARNING_HOME || join(homedir(), '.morecoffee', 'learning');
        const normalized = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
        if (process.env.MC_MODEL_DISABLED === '1' || !isAbsolute(home) || lstatSync(home).isSymbolicLink()
            || normalized(home) === normalized(learningHome)) return null;
        const read = (path, max) => {
            const s = lstatSync(path);
            if (!s.isFile() || s.isSymbolicLink() || s.size > max) throw new Error('invalid_model_file');
            return readFileSync(path);
        };
        const active = JSON.parse(read(join(home, 'current.json'), 4096));
        const revoked = JSON.parse(read(join(home, 'revocations.json'), 131072));
        const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
        const fields = (value, keys) => value && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
        const tasks = ['symbol_disambiguation', 'patch_quality', 'document_suitability', 'tool_call_suitability', 'input_block_retention'];
        if (!fields(active, ['schema', 'sequence', 'bundle_sha256', 'models']) || active.schema !== 'mc.models.current.v1'
            || !fields(revoked, ['schema', 'sequence', 'bundle_sha256', 'revoked_model_sha256']) || revoked.schema !== 'mc.models.revocations.v1'
            || [active, revoked].some(p => !Number.isSafeInteger(p.sequence) || p.sequence < 1 || !hex(p.bundle_sha256))
            || revoked.sequence < active.sequence || (revoked.sequence === active.sequence && revoked.bundle_sha256 !== active.bundle_sha256)
            || !fields(active.models, tasks) || Object.values(active.models).some(v => v !== null && !hex(v))
            || !Array.isArray(revoked.revoked_model_sha256) || revoked.revoked_model_sha256.some(v => !hex(v))
            || new Set(revoked.revoked_model_sha256).size !== revoked.revoked_model_sha256.length) return null;
        const sha = active.models?.symbol_disambiguation;
        if (!hex(sha) || revoked.revoked_model_sha256.includes(sha) || lstatSync(join(home, 'models')).isSymbolicLink()) return null;
        const bytes = read(join(home, 'models', sha + '.json'), 16384);
        if (createHash('sha256').update(bytes).digest('hex') !== sha) return null;
        const model = JSON.parse(bytes);
        if (model.schema !== 'mc.learned.v1' || model.policy !== 'mc.grouped-fresh-audit.v1' || model.task !== 'symbol_disambiguation' || model.approved !== true || model.abstain_gap !== 0.5
            || Object.keys(model.weights || {}).length !== FEATURE_KEYS.length || FEATURE_KEYS.some(k => !Number.isFinite(model.weights[k]) || Math.abs(model.weights[k]) > 32)
            || !Number.isFinite(model.bias) || Math.abs(model.bias) > 32) return null;
        return { ...model, model_sha256: sha };
    } catch { return null; }
}
export let MODEL_SHA256 = null;
export const DEFAULT_WEIGHTS = Object.freeze(ARTIFACT.weights);
export const ABSTAIN_GAP = ARTIFACT.abstain_gap;
const evidenceKeys = FEATURE_KEYS.filter(k => k !== 'degree' && k !== 'bias');
export function rankFeatures(candidates, { weights, abstainGap = ABSTAIN_GAP } = {}) {
    const learned = weights === undefined ? localModel() : null;
    if (weights === undefined) weights = learned?.weights || DEFAULT_WEIGHTS;
    MODEL_SHA256 = learned?.model_sha256 || null;
    const result = value => ({ ...value, model_sha256: learned?.model_sha256 || null });
    if (!Array.isArray(candidates) || candidates.length > 100000 || !Number.isFinite(abstainGap) || abstainGap <= 0)
        throw new Error('invalid_symbol_disambiguation_request');
    if (FEATURE_KEYS.some(k => !Number.isFinite(weights[k]))) throw new Error('invalid_weights');
    const ids = new Set();
    const ranked = candidates.map(c => {
        if (!c || typeof c.id !== 'string' || !c.id || ids.has(c.id) || Object.keys(c.features || {}).length !== FEATURE_KEYS.length || FEATURE_KEYS.some(k =>
            !Number.isFinite(c.features?.[k]) || c.features[k] < 0 || c.features[k] > 1)) throw new Error('invalid_candidate_features');
        ids.add(c.id);
        const score = FEATURE_KEYS.reduce((sum, k) => sum + weights[k] * c.features[k], 0);
        if (!Number.isFinite(score)) throw new Error('nonfinite_score');
        return { ...c, score };
    }).sort((a, b) => b.score - a.score);
    const gap = ranked.length > 1 ? ranked[0].score - ranked[1].score : null;
    if (!ranked.length) return result({ verdict: 'abstain', gap, ranked, reason: 'no_candidates' });
    if (ranked.length === 1) return result({ verdict: 'confident', gap, ranked, reason: 'unique' });
    let verdict = gap >= abstainGap ? 'confident' : 'abstain';
    const equivalent = verdict === 'confident' && ranked.slice(1).some(c => evidenceKeys.every(k => c.features[k] === ranked[0].features[k]));
    if (equivalent) return result({ verdict: 'abstain', gap, ranked, reason: 'equivalent_query_evidence' });
    const nonVendored = ranked.filter(c => c.features.vendored === 0).length;
    const suffix = nonVendored === 0 ? '|vendored_pool' : nonVendored === 1 ? '|lone_source' : '';
    const diffs = FEATURE_KEYS.map(k => [k, (ranked[0].features[k] - ranked[1].features[k]) * weights[k]])
        .filter(([, d]) => d > 1e-9).sort((a, b) => b[1] - a[1]);
    const reason = verdict === 'confident' ? 'by:' + (diffs.slice(0, 3).map(([k]) => k).join('+') || 'score') : gap < 1e-6 ? 'tie' : 'weak_gap';
    return result({ verdict, gap, ranked, reason: reason + suffix });
}
