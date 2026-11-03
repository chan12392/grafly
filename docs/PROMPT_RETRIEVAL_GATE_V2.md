# Expanded prompt-gate evaluation

The first three-repeat comparison was insufficient: it measured latency and
output equality on four inputs, not the safety of skipping new requests.
This follow-up remains on `test/prompt-retrieval-gate`; the live hook is unchanged.

## New challenge set and discovered failures

`test/fixtures/prompt-gate-evaluation.json` contains 112 synthetic, distinct
prompts authored for this follow-up, including Korean, English, short queries,
mixed conversation/tasks, and ambiguous follow-ups. The same file and labels
were used before and after the fix. Its SHA-256 at evaluation time was
`adb96535e1debcb611fe24b71ff3a0e97abfe4c7590972ff297de834813193f2`.

| Group | Cases | v1 wrongly skipped | v2 wrongly skipped |
| --- | ---: | ---: | ---: |
| Short technical queries | 24 | 23 | 0 |
| Longer technical requests | 24 | 0 | 0 |
| Tool discussion with a task attached | 16 | 13 | 0 |

The inherited 12-character cutoff lost inputs such as `auth`, `App.vue`, and
`로그인 오류`. The new v1 substring-based tool-discussion rule introduced an
additional failure: requests such as `Reduce tool calls in the renderer.` and
`토큰 절약하도록 캐시 붙여줘` were treated as conversation.

v2 removes the length cutoff and requires every complete clause to match a
recognized conversation pattern before skipping retrieval. Unknown clauses,
including short queries, retain retrieval. This also protects mixed requests
without growing a list of every possible task verb.

All 64 required-retrieval cases and 36 clear-conversation cases now meet their
labels. The 12 ambiguous cases are observational, not counted as passing labels;
all retain retrieval. This is a regression/challenge set used to repair the
implementation, not an independent estimate of population accuracy.

## Additional verification

`node scripts/run-tests.mjs`: **54 tests passed, 0 failed** (Node v24.14.1,
Windows). New coverage includes:

- 192 prefix/suffix/line-break combinations: attaching a task preserves retrieval.
- Adapter-level checks that formerly skipped short/mixed requests invoke the child CLI.
- Two independent repository sessions: chat preserves the session file byte-for-byte;
  duplicate suppression remains local to the session.
- Home `thread_id` session routing and unchanged session-start behavior.
- Large payloads, including 250,000 characters and 10,000 repeated conversation
  clauses, bounded by a separate child-process timeout.

Reproduce the corpus and automated tests from the branch:

```powershell
node scripts/evaluate-prompt-gate.mjs
npm test
```

## Real-index replay

The installed hook and candidate run as separate fresh Node processes against
the same ten existing home indexes. Four new prompts each receive 20 measured
pairs; case order and variant order are randomized with seed `20260920`.
One warm-up pair per prompt is excluded. Fresh sessions isolate the timing
comparison from pointer deduplication. No competing test suite runs during replay.

Eight additional boundary prompts and two four-turn session sequences exercise
mixed requests, short queries, state preservation, fresh-session isolation, and
both `session_id` and `thread_id` in the real home path.

All **192 hook invocations** completed without process errors or timeouts:
160 measured invocations, eight warm-ups, 16 boundary-case invocations, and eight
sequence invocations. All retrieval-preservation and session-state assertions
passed. The 40 measured technical pairs returned byte-identical context.

| Prompt | Installed median / p95 (ms) | Candidate median / p95 (ms) | Context characters |
| --- | ---: | ---: | ---: |
| Thanks / acknowledgment | 2,417 / 2,524 | 68 / 73 | 938 → 0 |
| Agent tool-usage question | 2,401 / 2,510 | 67 / 74 | 663 → 0 |
| `relevantRetrieval` / pointers | 2,364 / 2,664 | 2,420 / 2,616 | 729 → 729 |
| `writeSession` / session cache | 2,607 / 2,943 | 2,699 / 2,922 | 748 → 748 |

These p95 values are empirical nearest-rank percentiles of 20 measurements per
cell. They are not confidence bounds or cold-cache measurements. Technical
queries did not become faster; their median increased by 56–92 ms in this run.
Both conversation cases skipped session writes in all 20 candidate runs.

The installed hook, home workspace manifest, ten saved graph files, and original
checkout state stayed unchanged. Candidate source hashes also stayed unchanged
during replay. Only temporary experiment session files were removed afterward.
Raw evidence is in `C:\Users\example\Backups\Grafly-prompt-gate-expanded-20260920`:
`before.json`, `after.json`, `replay.py`, `replay.json`, per-run outputs,
`search-quality.json`, and archived full test logs in `automated-validation`.

## Search quality boundary

The new query `Where does writeSession persist the session cache?` retrieves the
same context in both versions, but neither top-three result contains `writeSession`.
The function exists in source (`dist/claude/state.js:L30-L32`) and in the saved
Grafly graph, so the index contains the target. The other technical query,
`Explain relevantRetrieval and injectedPointers handling`, does retrieve
`relevantRetrieval` first. Across the 20 measured repetitions per version,
expected-symbol presence was 20/20 for `relevantRetrieval` and 0/20 for
`writeSession` in both versions. These repetitions are two distinct quality
queries, not 40 independent search-quality examples.

Output equality is a compatibility check, not proof of accurate ranking. This
existing workspace-ranking gap remains unresolved by the prompt gate. Its
results must be reported separately from the gate's pass/fail counts.

The timing samples do not measure completed agent-task quality, total tool
calls, billed tokens, or a broad real-world prompt distribution. Unknown
conversation may still trigger retrieval. No live installation, merge, push,
or release is part of this experiment.
