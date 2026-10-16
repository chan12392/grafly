// Invoked only inside the daemon's serialized request queue.
// Reuse the actual CLI actions and their error/output contracts in-process.
export async function executeCliRequest({ argv, cwd }) {
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
