import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../../dist/mc-runtime/runtime.js';
import { MODEL_TASKS } from '../../dist/mc-runtime/models.js';

// Synthetic gate metadata exercises delivery only; it is never a production promotion.
export function symbolModel(delta = 0) {
  const weights = JSON.parse(readFileSync(new URL('../../dist/circuit/mc/symbol_disambiguation.json', import.meta.url))).weights;
  const digest = 'a'.repeat(64), metrics = correct => ({ count: 4, correct, wrong_confident: 0, confident: 3 });
  return { schema: 'mc.learned.v1', policy: 'mc.grouped-fresh-audit.v1', task: 'symbol_disambiguation', approved: true,
    abstain_gap: 0.5, bias: 0, weights: { ...weights, exact_name: weights.exact_name + delta },
    dataset_sha256: digest, trainer_sha256: digest, split_sha256: { train: digest, validation: digest, audit: digest },
    incumbent_model_sha256: null, fit: { epochs: 32, learning_rate: 0.5, l2: 0.001, seed: null },
    validation: { candidate: metrics(3), incumbent: metrics(2) }, audit: { candidate: metrics(3), incumbent: metrics(2) } };
}
export function installConsumerModel(home, model, sequence = 1) {
  mkdirSync(join(home, 'models'), { recursive: true });
  const bytes = Buffer.from(JSON.stringify(model)), digest = sha256(bytes);
  writeFileSync(join(home, 'models', digest + '.json'), bytes);
  writeFileSync(join(home, 'revocations.json'), JSON.stringify({ schema: 'mc.models.revocations.v1', sequence,
    bundle_sha256: digest, revoked_model_sha256: [] }));
  writeFileSync(join(home, 'current.json'), JSON.stringify({ schema: 'mc.models.current.v1', sequence, bundle_sha256: digest,
    models: Object.fromEntries(MODEL_TASKS.map(task => [task, task === model.task ? digest : null])) }));
  return digest;
}
