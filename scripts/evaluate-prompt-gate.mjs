import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const corpusPath = fileURLToPath(new URL('../test/fixtures/prompt-gate-evaluation.json', import.meta.url));
const source = readFileSync(corpusPath);
const corpus = JSON.parse(source);
const gatePath = resolve(process.argv[2] || fileURLToPath(new URL('../dist/claude/prompt-gate.js', import.meta.url)));
const { shouldRetrievePrompt } = await import(pathToFileURL(gatePath).href);
const rows = corpus.groups.flatMap(group => group.prompts.map(prompt => ({
  group: group.name, expected: group.expect, prompt, actual: shouldRetrievePrompt(prompt) ? 'retrieve' : 'skip',
})));
const seen = new Set();
for (const row of rows) {
  if (seen.has(row.prompt)) throw new Error('Duplicate evaluation prompt: ' + row.prompt);
  seen.add(row.prompt);
}
const failures = rows.filter(r => r.expected !== 'observe' && r.expected !== r.actual);
const summary = corpus.groups.map(g => ({ group: g.name, expected: g.expect,
  total: g.prompts.length, retrieved: rows.filter(r => r.group === g.name && r.actual === 'retrieve').length,
  skipped: rows.filter(r => r.group === g.name && r.actual === 'skip').length,
  mismatches: failures.filter(r => r.group === g.name).length,
}));
const report = { corpusSha256: createHash('sha256').update(source).digest('hex'),
  gateSha256: createHash('sha256').update(readFileSync(gatePath)).digest('hex'),
  total: rows.length, summary, failures, rows };
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, rows: undefined }, null, 2));
process.exitCode = failures.length ? 1 : 0;
