# Explicit reviews and MC log reasons

Judgment logs and output archives stay local. A follow-up search or narrowed
candidate list is a navigation observation, not proof that an answer was right.
An explicit review records a checked expected result and the evidence for it.
It is an operator assertion, not an independently verified ground truth.

## Review a judgment

1. Run `grafly callers <symbol> --json`. For an ambiguous query, the saved
   judgment ID is `circuit.jid`; exact candidate IDs are in `circuit.scores`.
   Human output also prints the judgment ID. Workspace output prints an ID per
   child; give that child directory to the feedback command.
2. Check the source and task intent, then record the exact correct candidate:

   ```sh
   grafly feedback <jid> 'src/worker.js#run' --evidence 'Confirmed the call imports this definition at src/client.js:12'
   ```

   If the query genuinely has no uniquely justified candidate, use `abstain`:

   ```sh
   grafly feedback <jid> abstain /path/to/repo --evidence 'Both definitions satisfy the query; no caller or path was specified'
   ```

3. Inspect reviewed results:

   ```sh
   node scripts/circuit-log-analyze.mjs --dir /path/to/repo
   ```

The command requires an existing judgment in that repository's retained current
or rotated log, an exact candidate ID (or `abstain`), and nonempty evidence of at
most 4096 characters. `--dir` and `GRAFLY_CIRCUIT_LOG` retain their existing log
location meaning; `GRAFLY_CIRCUIT_LOG=0/off` prevents review writes too.
The optional repository argument is the third positional argument. Review lookup
reads at most the final 3 MiB of each log. If an oversized judgment is unavailable,
rerun the query and review the new ID against its current source and task intent.

Reviews append `grafly.circuit.label.v1` records with `source: explicit`, `jid`,
`root`, `expected`, `evidence`, and `ts`. They do not rewrite old judgments. Repeat
the command to correct a review; the analyzer uses the latest timestamp per
repository and judgment, with input order breaking ties. Invalid or unmatched
labels and legacy adopt/reject events do not count as verified reviews.
Top-1 target agreement and verdict agreement are reported separately: abstaining
when a unique target is known is not a confident correct selection.

Existing unreviewed logs stay unreviewed. When MC local learning is explicitly
enabled, current judgments and explicit reviews also enter its local inbox.
Unlabeled navigation does not become a training label. The verified MC runtime
owns training and activation gates; see [local learning integration](MC_RUNTIME.md).
Nothing is uploaded. Logs still rotate with
one backup near 1.5 MiB, so export reviewed records before their retention ends
if they will be used in a durable, separately validated dataset.

## Output archive reasons

New `grafly run` manifests keep the existing schema and add `mc_attempted` plus
`mc_reason_codes` when MC returned a result. `reason` distinguishes:

| Reason | Meaning |
| --- | --- |
| `unsupported_command` | Invocation semantics are outside supported forms. |
| `output_too_small` | Less than 4 KiB; MC was not called. |
| `command_failed` | A real command failure; original output is retained. |
| `incomplete_output` | Interrupted, timed out, or otherwise incomplete. |
| `disabled` | `GRAFLY_TOOL_OUTPUT=0` disables capture and MC. |
| `streamed` | Raw live output after the buffer limit was exceeded. |
| `archive_unavailable` | Raw evidence could not be archived. |
| `no_supported_reduction` | MC ran but found no applicable reduction. |
| `insufficient_savings` | Proposed reduction failed the existing byte savings gate. |
| `mc_unavailable`, `mc_abstained`, or validation errors | Existing raw fallback after an MC or validation failure. |

Successful reductions retain their channel reason, such as `search_dedup` or
`passing_test_details`. A missing channel reason becomes `mc_passthrough`.
`mc_reason_codes` preserves a proposal's reason even when the runner rejects its
savings. Raw streams, original exit codes, retention limits, and thresholds are
unchanged. Old `not_reduced` records are not guessed or relabeled retroactively.
