import * as child from 'node:child_process';
import commands from './executable.cjs';

// Internal tools must not resolve executable names against a scanned checkout.
export function spawn(command, args, options) {
    return child.spawn(...commands.invocation(command, args, options));
}
export function spawnSync(command, args, options) {
    try { return child.spawnSync(...commands.invocation(command, args, options)); }
    catch (error) { return { error, status: null, signal: null, stdout: null, stderr: null }; }
}
export function execFileSync(command, args, options) {
    return child.execFileSync(...commands.invocation(command, args, options));
}
