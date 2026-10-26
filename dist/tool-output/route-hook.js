#!/usr/bin/env node
import { routeHook } from './route.js';
let raw = '';
try {
    for await (const part of process.stdin) {
        raw += part;
        if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('oversize');
    }
    process.stdout.write(JSON.stringify(routeHook(process.argv[2], JSON.parse(raw))));
} catch { process.stdout.write('{}'); }
