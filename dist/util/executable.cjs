const { existsSync, statSync } = require('node:fs');
const path = require('node:path');

function executable(command, env = process.env) {
    if (process.platform !== 'win32' || path.isAbsolute(command)) return command;
    if (/[\\/]/.test(command)) return path.resolve(command);
    const entries = Object.entries(env);
    const value = key => entries.find(([name]) => name.toUpperCase() === key)?.[1] || '';
    const extensions = path.extname(command) ? [''] : (value('PATHEXT') || '.EXE;.COM;.CMD;.BAT').split(';');
    for (const entry of value('PATH').split(';')) {
        const dir = entry.replace(/^"|"$/g, '');
        if (!path.isAbsolute(dir) || path.resolve(dir).toLowerCase() === process.cwd().toLowerCase()) continue;
        for (const extension of extensions) {
            const candidate = path.join(dir, command + extension);
            try { if (statSync(candidate).isFile()) return candidate; } catch {}
        }
    }
    const error = new Error('Executable not found on trusted PATH: ' + command);
    error.code = 'ENOENT';
    throw error;
}

function invocation(command, args, options = {}) {
    if (command === 'npm' && process.platform === 'win32') {
        const npm = executable('npm', options.env);
        const cli = path.join(path.dirname(npm), 'node_modules', 'npm', 'bin', 'npm-cli.js');
        if (!existsSync(cli)) throw new Error('Cannot locate npm CLI beside its trusted launcher');
        return [process.execPath, [cli, ...args], { ...options, shell: false, windowsHide: true }];
    }
    return [executable(command, options.env), args, { ...options, windowsHide: true }];
}
module.exports = { executable, invocation };
