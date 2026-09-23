// Shared by the ESM runtime and dependency-free host shims.
const { existsSync } = require('node:fs');
const { join, isAbsolute } = require('node:path');
const INDEX_DIR = '.grafly';
const LEGACY_INDEX_DIRS = ['grafly', 'graft'];
function hasIndexAt(dir) {
    return existsSync(join(dir, '.graph', 'wiring.json')) || existsSync(join(dir, 'workspace.json'));
}
function indexDir(root, override) {
    if (override) return isAbsolute(override) ? override : join(root, override);
    for (const name of [INDEX_DIR, ...LEGACY_INDEX_DIRS]) {
        const dir = join(root, name);
        if (hasIndexAt(dir)) return dir;
    }
    // A normal source directory named grafly is never an index.
    return join(root, INDEX_DIR);
}
module.exports = { INDEX_DIR, LEGACY_INDEX_DIRS, hasIndexAt, indexDir };
