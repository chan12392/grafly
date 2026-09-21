# Reversible session compaction

`grafly session-compact` applies MoreCoffee's deterministic `session_compact`
judgment rules to a **copy of a Codex rollout JSONL file**. It runs locally with
no model call. It does not replace a running agent's context, replay tools,
summarize user instructions, or guarantee future answer quality.

For same-thread replacement through an owned Codex app-server process, see
[live session compaction](LIVE_SESSION_COMPACT.md). That opt-in adapter has a
separate protocol and compatibility boundary; this file command remains unchanged.

```powershell
grafly session-compact ./rollout.jsonl --json
grafly session-expand ./rollout.jsonl.compacted.jsonl
```

The original remains untouched. Compaction produces three related artifacts:

- `rollout.jsonl.compacted.jsonl`: the compacted copy.
- `rollout.jsonl.compacted.jsonl.manifest.json`: source positions and SHA-256 digests.
- `rollout.jsonl.compacted.jsonl.archive/`: content-addressed original text,
  normalized completed batches, and exact original changed/deleted records.

Keep all three together. `session-expand` reconstructs the original bytes,
including multipart content, metadata, whitespace, CRLF and interleaved events.
It checks the compacted-file digest, every archive digest, and the final source
digest before publishing the restored copy. Missing or corrupt inputs cause a
nonzero exit and no restored output. The pre-manifest prototype's text-only
archives cannot recover original record shapes; recompact its original file.

Both commands refuse to overwrite existing outputs. Use `--out <new-path>` for
another run. Sidecars are named after that output path. A failed write can leave
incomplete sidecars; keep them for inspection and retry with another output path.
Compacted and restored outputs are published from complete temporary files using
an exclusive hard link; the destination filesystem must support hard links.

## What gets preserved

- System, developer, user and ordinary assistant text remains verbatim.
- The last eight normalized messages and their pending/recent call pairs remain.
  Change this with `--keep-last <integer>`.
- Errors, unknown outcomes, still-running results and unsupported parts such as
  images remain. A call's `completed` status alone does not prove success.
  The adapter recognizes explicit result flags, exit codes and the local
  `Script completed/failed` result envelope; nested explicit failures win.
- Known verification output formats are retained in full. Use `--verify <id...>`
  for other tool-result evidence or `--pin <id...>` for any message that must stay.
  Unknown IDs are rejected. Messages without a usable native ID get a stable
  `mc_line_N` ID based on the source line; suffixes resolve collisions. These
  IDs appear in the JSON decision without changing the source file.

Old successful outputs can become exact-duplicate or archive pointers. A fully
completed, unprotected call/result group can become an assistant receipt with
an argument preview and a digest-addressed batch reference. The host compares
batch and individual-output proposals and keeps the batch proposal only if it
does not increase either the normalized message bytes without archive metadata
or the actual rollout file bytes. `--no-batches` selects individual outputs only.

Malformed JSON, duplicate native message IDs, unpaired tool results and invalid
archive digests are rejected. Scanned code, tool arguments and archived commands
are data; none is executed by these commands.

## Reading measurements

`measurements.normalized_*` describes serialized normalized text messages,
excluding archive bookkeeping. `measurements.rollout_*` describes the entire
JSONL file, including reasoning, events and provider state left in place.
Non-text data is preserved in the rollout but is not included in normalized
text measurements. Archive and manifest storage bytes are reported separately;
this feature reduces context, not total disk usage.

The MC `decision.input_bytes`, `output_bytes` and `--target-bytes` budget use the
channel's normalized serialization **including** archive bookkeeping. If the
budget cannot be met without protected loss, the command reports `abstained`
and writes no artifacts. An abstention is a judgment result, not a CLI failure.

Byte reduction is not measured token, billing or model-latency reduction. The
adapter currently accepts Codex JSONL, not arbitrary provider transcripts.
Continuing a live session requires host-specific context replacement; these
commands only create and validate standalone files. Exact restoration requires
the compacted file to remain unchanged: continue from a separate working copy.

## Verification

Run `npm test`. Tests cover the complete CLI round trip plus batch restoration,
interleaving, native ID gaps, Unicode previews, multipart content, explicit
failures, pending results, pins, verification evidence, corruption and refusal
to overwrite files. No external model calls are needed.

Local validation on 2026-09-20: all 36 repository tests passed. Two private
frozen rollout copies were compacted and expanded through the installed
`grafly` command; both restored the complete original bytes and kept their
source files unchanged. A further message appended to each normalized
compacted copy passed call/result pairing validation. This checks structural
continuation, not an LLM's task performance or a running host's context switch.

| Input | Individual outputs only | Selected proposal | Whole rollout reduction |
| --- | ---: | ---: | ---: |
| Small rollout used by Devin | 37.79% | 37.79% (no batch receipts) | 15.08% |
| Longer native rollout with missing IDs | 73.31% | 78.78% (3 batch receipts) | 50.74% |

The middle columns measure normalized bytes without archive bookkeeping;
the individual-output column is a counterfactual using the same corrected
adapter and input. Separately, the original frozen MC channel request produced
an identical complete decision in the JS judge: 773,208 B to 163,703 B (78.83%).
The raw private transcripts and local archives are not repository fixtures.
