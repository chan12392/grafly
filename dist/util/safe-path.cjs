const { lstatSync } = require('node:fs');
const { resolve, relative, isAbsolute, parse, join, sep } = require('node:path');
const { homedir, tmpdir } = require('node:os');

// Check every component: a safe leaf can still sit under a redirected directory.
function assertNoSymlinks(target, boundary) {
    const full = resolve(target);
    let root = boundary ? resolve(boundary) : parse(full).root;
    // Trusted runtime roots may themselves be platform aliases (e.g. macOS /var).
    if (!boundary) for (const anchor of [process.cwd(), homedir(), tmpdir()]) {
        const base = resolve(anchor), child = relative(base, full);
        if (child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child) && base.length > root.length)
            root = base;
    }
    const rel = relative(root, full);
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
        throw new Error('Grafly path escapes its root');
    let current = root;
    for (const part of rel.split(sep).filter(Boolean)) {
        current = join(current, part);
        try {
            if (lstatSync(current).isSymbolicLink())
                throw new Error('Grafly refuses a symlinked path: ' + current);
        } catch (error) {
            if (error.code === 'ENOENT') break;
            throw error;
        }
    }
    return full;
}
module.exports = { assertNoSymlinks };
