import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Invoked only inside the daemon's serialized request queue.
export async function executeCliRequest({ command, argv, cwd }) {
    // MC pins its runtime/model at import; each judgment needs a fresh process.
    if (command === 'callers') return new Promise(done => {
        execFile(process.execPath, [fileURLToPath(new URL('../entry.js', import.meta.url)), ...argv],
            { cwd, env: { ...process.env, GRAFLY_NO_DAEMON: '1' }, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
            (error, stdout, stderr) => done({ stdout, stderr: stderr || (error && !Number.isInteger(error.code) ? error.message + '\n' : ''),
                exitCode: error ? (Number.isInteger(error.code) ? error.code : 1) : 0 }));
    });
    const { runCli } = await import("../cli.js");
    const prior = { cwd: process.cwd(), exitCode: process.exitCode,
        stdout: process.stdout.write, stderr: process.stderr.write };
    let stdout = "", stderr = "";
    const capture = (append) => (chunk, encoding, callback) => {
        append(Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === "string" ? encoding : undefined) : String(chunk));
        const done = typeof encoding === "function" ? encoding : callback;
        if (done) queueMicrotask(done);
        return true;
    };
    try {
        process.chdir(cwd);
        process.exitCode = 0;
        process.stdout.write = capture((text) => { stdout += text; });
        process.stderr.write = capture((text) => { stderr += text; });
        const exitCode = await runCli(argv);
        return { stdout, stderr, exitCode };
    } finally {
        process.stdout.write = prior.stdout; process.stderr.write = prior.stderr;
        process.exitCode = prior.exitCode;
        process.chdir(prior.cwd);
    }
}
