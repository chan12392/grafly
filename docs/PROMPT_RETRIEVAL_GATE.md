# Prompt retrieval gate experiment

This records the initial `2b5811a` experiment. The [expanded evaluation](PROMPT_RETRIEVAL_GATE_V2.md)
found and corrected missed technical requests and records a remaining search-ranking gap.

Branch: `test/prompt-retrieval-gate`, based on `14dc6cd` (`master`).

The prompt hook previously searched every prompt of at least 12 characters,
including acknowledgments, progress questions, and questions about the agent's
tool usage. The new local gate skips recognizable conversation before graph
retrieval. Code anchors and mixed code requests take priority. Uncertain long
prompts retain retrieval; short code identifiers now bypass the old length limit.
This uses no model, network request, or additional tool call.

`dist/claude/hooks.js` and the Codex/Devin adapter in
`scripts/grafly-devin-hook.cjs` share `dist/claude/prompt-gate.js`. The adapter is
a tracked copy of the existing local adapter, with adjacent-package resolution
for branch testing. A standalone copy requires a package containing the new gate.
Conversation also skips automatic indexing; session-start behavior is unchanged.

## Verification, 2026-09-20

Windows, Node v24.14.1. `npm test` (equivalently `node scripts/run-tests.mjs`):
**44 passed, 0 failed**. The eight new tests cover 40 Korean/English prompt
examples plus child-process invocation, session writes, pointer deduplication,
home/repository routing, short identifiers, message-field compatibility, and
automatic-build suppression.

The installed hook and branch adapter were each run three times per prompt over
the same ten saved home indexes, alternating order and using fresh session IDs.
Times below are medians of whole hook subprocess duration, including startup.

| Prompt | Installed hook | Branch adapter | Injected context characters |
| --- | ---: | ---: | ---: |
| Agent's most-used tools / Grafly tool-call savings | 2,500 ms | 67 ms | 833 → 0 |
| Korean progress question | 1,704 ms | 72 ms | 0 → 0 |
| Locate `federateAsk` implementation | 2,355 ms | 2,424 ms | 871 → 871 |
| Short symbol `loadGraph` | 65 ms | 66 ms | 0 → 144 (literal-search hint) |

Both conversation samples stopped creating retrieval session records (3 → 0
each). The code query retained the expected function in all three runs and
produced identical context. The short-symbol home path supplies a `grafly grep`
hint; it does not itself execute that grep. Repository short-symbol queries do
execute retrieval, as verified with an instrumented child CLI.

Graph/retrieval module contents matched the installed package after normalizing
line endings. The remaining existing CLI difference is outside the home-hook
path; the changed repository hook is also bypassed by the home adapter.

The live hook and all ten graph-file SHA-256 hashes stayed unchanged. The
original checkout's existing changes stayed unchanged. Temporary benchmark
session files were removed. Raw local evidence and the benchmark script are in
`C:\Users\example\Backups\Grafly-prompt-gate-20260920` (`benchmark.json`,
per-run `.stdout`, and `npm-test.log`).

These are hook latency/context measurements, not end-to-end task token costs or
assistant tool-call counts. Three repetitions and a small prompt set do not
establish general classification accuracy. The gate intentionally retains
unrecognized long conversation and ambiguous requests; a later step can still
run Grafly manually. No live hook installation, merge, push, or release was done.
