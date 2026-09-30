const { spawn } = require('node:child_process');
const path = require('node:path');

const psString = value => "'" + value.replace(/'/g, "''") + "'";
// Start-Process takes a single Windows command line, not an argv array.
const windowsArg = value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';

/** Launch index maintenance without making a PowerShell hook wait for it. */
function spawnBackground(file, args, options = {}) {
    let command = file, argv = args;
    if (process.platform === 'win32') {
        // detached/unref alone still leaves descendants in PowerShell's native
        // command job. Start-Process without -Wait releases that job; it keeps
        // the index worker hidden and lets the hook deliver cached context now.
        const script = '$ErrorActionPreference = "Stop"; $ProgressPreference = "SilentlyContinue"; Start-Process -FilePath ' + psString(file)
            + ' -ArgumentList ' + psString(args.map(windowsArg).join(' '))
            + ' -WorkingDirectory ' + psString(options.cwd || process.cwd())
            + ' -WindowStyle Hidden';
        command = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        argv = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
    }
    const child = spawn(command, argv, { ...options, detached: process.platform !== 'win32', stdio: 'ignore', windowsHide: true });
    child.on('error', () => {}); // Maintenance is optional; retrieval stays usable.
    // Keep the short Windows launcher alive until Start-Process has handed off
    // the worker. Exiting earlier can terminate it before it starts the worker.
    if (process.platform !== 'win32') child.unref();
    return child;
}

module.exports = { spawnBackground };
