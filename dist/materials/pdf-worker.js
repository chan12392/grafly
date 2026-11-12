import { parentPort } from "node:worker_threads";
import { getDocumentProxy, renderPageAsImage } from "unpdf";
let pdf;
parentPort.on("message", async ({ bytes, page, render }) => {
    try {
        if (bytes) {
            pdf = await getDocumentProxy(bytes, { isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
            parentPort.postMessage({ numPages: pdf.numPages });
            return;
        }
        const p = await pdf.getPage(page);
        const content = await p.getTextContent();
        const text = content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").slice(0, 2_000_000);
        let png;
        if (!text.trim() && render) {
            const viewport = p.getViewport({ scale: 1 });
            const scale = Math.min(1.5, 2000 / Math.max(viewport.width, viewport.height));
            png = await renderPageAsImage(pdf, page, { scale, canvasImport: () => import("@napi-rs/canvas") });
        }
        parentPort.postMessage({ text, png });
    } catch (error) { parentPort.postMessage({ error: String(error.message ?? error) }); }
});
