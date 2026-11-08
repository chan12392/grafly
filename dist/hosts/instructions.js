/**
 * The one canonical Grafly instruction block, rendered into each host's
 * native format. Content changes happen HERE only; renderers just wrap it.
 */
export function instructionBody() {
    // Compact by design: this block loads into every session on every host,
    // most of which have no grafly skill file — so it stays self-contained
    // (every command named, no skill pointer) but drops the tutorial prose.
    return `## Grafly — repo context graph

Indexed in \`.grafly/\` — for ANY task query the graph (exact file:line) before
grep/read. Pick ONE tool, act on its answer, don't re-ask reworded:

- \`grafly ask "<task>" --source\` — ranked nodes with code inlined (\`--full\` whole
  span, \`--in <scope>/\` narrows a monorepo). Top-N, not exhaustive: for "every
  occurrence" use \`grafly grep "<literal>"\` (raw \`grep -rn\` only for unindexed files).
- \`grafly skeleton <file>\` — a file's API ~10× cheaper than reading it ·
  \`grafly callers <sym> [--direction out] [--depth N|all]\` — exact edges/blast radius ·
  \`grafly map\` — repo orientation.
- Open source only at a node's file:line ("+N more lines" → open that range); never
  re-read whole files. Every node: \`.grafly/INDEX.md\`. Refresh: \`grafly build\`.`;
}
export function cursorRule() {
    return `---
description: Use the Grafly context graph in .grafly/ before exploring source
alwaysApply: true
---
${instructionBody()}
`;
}
export function kiroSteering() {
    return `---
inclusion: always
---
${instructionBody()}
`;
}
export function windsurfRule() {
    return `${instructionBody()}
`;
}
