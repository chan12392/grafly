// A failed command must end its request, not the resident process.
export class CommandExit extends Error {
    constructor(exitCode) { super(""); this.exitCode = exitCode; }
}
export function exitCommand(exitCode) { throw new CommandExit(exitCode); }
