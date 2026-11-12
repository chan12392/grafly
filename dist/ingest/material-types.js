import { extname } from "node:path";

export const MAX_MATERIAL_BYTES = 20_000_000;
export function materialKind(path) {
    if (isSensitivePath(path)) return null;
    const ext = extname(path).toLowerCase();
    if ([".md", ".mdx", ".txt", ".rst"].includes(ext)) return "document";
    if (ext === ".pdf") return "pdf";
    if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) return "image";
    return undefined;
}
import { isSensitivePath } from "../util/sensitive-path.js";
