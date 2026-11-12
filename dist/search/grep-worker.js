import { parentPort, workerData } from "node:worker_threads";
const { source, flags, control } = workerData;
const regex = new RegExp(source, flags);
parentPort.on("message", ({ lines, matches }) => {
    try {
        const result = new Uint8Array(matches);
        for (let i = 0; i < lines.length; i++) result[i] = Number(regex.test(lines[i]));
        Atomics.store(control, 0, 1);
    } catch {
        Atomics.store(control, 0, 2);
    }
    Atomics.notify(control, 0);
});
