import type { GraphV1 } from '../graph/types.js';
import type { Stats } from './state.js';
export declare function readWiring(projectDir: string): GraphV1 | null;
export declare function computeStats(w: GraphV1): Pick<Stats, 'nodeCount' | 'edgeCount' | 'languages' | 'totalCount' | 'readyCount'>;
//# sourceMappingURL=stats.d.ts.map