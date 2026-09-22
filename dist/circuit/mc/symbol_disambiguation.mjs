// Canonical MoreCoffee portable channel. Consumers generate copies, never fork rules.
import { readFileSync } from 'node:fs';
export const ARTIFACT = JSON.parse(readFileSync(new URL('./symbol_disambiguation.json', import.meta.url), 'utf8'));
export const FEATURE_KEYS = Object.freeze(Object.keys(ARTIFACT.weights));
export const DEFAULT_WEIGHTS = Object.freeze(ARTIFACT.weights);
export const ABSTAIN_GAP = ARTIFACT.abstain_gap;
const evidenceKeys = FEATURE_KEYS.filter(k => k !== 'degree' && k !== 'bias');
export function rankFeatures(candidates, { weights = DEFAULT_WEIGHTS, abstainGap = ABSTAIN_GAP } = {}) {
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
    if (!ranked.length) return { verdict: 'abstain', gap, ranked, reason: 'no_candidates' };
    if (ranked.length === 1) return { verdict: 'confident', gap, ranked, reason: 'unique' };
    let verdict = gap >= abstainGap ? 'confident' : 'abstain';
    const equivalent = verdict === 'confident' && ranked.slice(1).some(c => evidenceKeys.every(k => c.features[k] === ranked[0].features[k]));
    if (equivalent) return { verdict: 'abstain', gap, ranked, reason: 'equivalent_query_evidence' };
    const nonVendored = ranked.filter(c => c.features.vendored === 0).length;
    const suffix = nonVendored === 0 ? '|vendored_pool' : nonVendored === 1 ? '|lone_source' : '';
    const diffs = FEATURE_KEYS.map(k => [k, (ranked[0].features[k] - ranked[1].features[k]) * weights[k]])
        .filter(([, d]) => d > 1e-9).sort((a, b) => b[1] - a[1]);
    const reason = verdict === 'confident' ? 'by:' + (diffs.slice(0, 3).map(([k]) => k).join('+') || 'score') : gap < 1e-6 ? 'tie' : 'weak_gap';
    return { verdict, gap, ranked, reason: reason + suffix };
}
