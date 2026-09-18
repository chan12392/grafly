import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveContextDir } from '../util/state.js';
export function readWiring(projectDir) {
    try {
        return JSON.parse(readFileSync(join(resolveContextDir(projectDir), '.graph', 'wiring.json'), 'utf8'));
    }
    catch {
        return null;
    }
}
export function computeStats(w) {
    const nodes = w.nodes ?? [];
    const edges = w.edges ?? [];
    const readyCount = nodes.filter((n) => n.summary_state === 'ready').length;
    return {
        nodeCount: w.meta?.nodeCount ?? nodes.length,
        edgeCount: w.meta?.edgeCount ?? edges.length,
        languages: w.meta?.languages ?? [],
        totalCount: nodes.length,
        readyCount,
    };
}
//# sourceMappingURL=stats.js.map