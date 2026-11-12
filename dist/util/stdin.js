import { readSync } from "node:fs";

/** Bound allocation before reading hook input, including pipes that never send EOF. */
export function readStdinText() {
    const bytes = Buffer.allocUnsafe(1024 * 1024 + 1);
    let length = 0;
    while (length < bytes.length) {
        const size = readSync(0, bytes, length, Math.min(65536, bytes.length - length), null);
        if (!size) return bytes.subarray(0, length).toString("utf8");
        length += size;
    }
    throw new Error("Hook input exceeds 1 MiB");
}
