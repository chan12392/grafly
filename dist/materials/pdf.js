import { Worker } from "node:worker_threads";

/** PDF parsing/rendering has a shared ten-second budget, independent of model requests. */
export async function openPdf(bytes) {
    const worker = new Worker(new URL("./pdf-worker.js", import.meta.url), {
        execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let remaining = 10000, closed = false;
    worker.on("error", () => {});
    worker.on("exit", () => { closed = true; });
    const request = message => new Promise((resolve, reject) => {
        if (closed || remaining <= 0) { reject(new Error("PDF extraction exceeded its time budget")); return; }
        const started = performance.now();
        const finish = (error, value) => {
            clearTimeout(timer);
            worker.off("message", receive); worker.off("error", fail); worker.off("exit", exited);
            remaining -= performance.now() - started;
            if (error) reject(error); else resolve(value);
        };
        const receive = value => finish(value.error ? new Error(value.error) : null, value);
        const fail = error => finish(error);
        const exited = () => finish(new Error("PDF worker exited"));
        const timer = setTimeout(() => {
            closed = true; finish(new Error("PDF extraction exceeded its time budget")); void worker.terminate();
        }, remaining);
        worker.once("message", receive); worker.once("error", fail); worker.once("exit", exited);
        worker.postMessage(message);
    });
    try {
        const { numPages } = await request({ bytes: new Uint8Array(bytes) });
        return { numPages, readPage: (page, render) => request({ page, render }), close: () => worker.terminate() };
    } catch (error) { await worker.terminate(); throw error; }
}
