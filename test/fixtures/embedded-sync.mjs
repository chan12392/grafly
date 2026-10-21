import { createInterface } from 'node:readline';
import { contextDirFor } from '../../dist/context/node-file.js';
import { buildGraph } from '../../dist/graph/build.js';
import { readXerjState, syncXerj } from '../../dist/search/xerj.js';
import { openEmbedded } from '../../dist/search/embedded.js';

const [root, action = 'build'] = process.argv.slice(2);
const outDir = contextDirFor(root);
if (action === 'reader') {
    const reader = openEmbedded(outDir, readXerjState(outDir));
    console.log('ready');
    for await (const query of createInterface({ input: process.stdin }))
        console.log(JSON.stringify(reader.search(query, 10, undefined, false)));
} else {
    if (action === 'build') await buildGraph(root);
    console.log(JSON.stringify(await syncXerj(root, outDir, 'embedded')));
}
