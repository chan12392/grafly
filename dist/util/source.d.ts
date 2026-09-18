/** Read source text, decoding Windows tooling's common UTF-16LE output. UTF-16BE
 * is rare and unsupported by Node's built-in decoders, so callers silently skip it. */
export declare function readSourceFile(path: string): string | null;
//# sourceMappingURL=source.d.ts.map