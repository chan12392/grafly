# MC/JEV comparison consumer

Grafly remains an execution/context producer. It sends optional observations to
the existing Baekho local CLI broker; the harness gives MC and JEV equal inputs,
joins their receipts and delivers feedback to MoreCoffee.
MC owns scoring, training, independent evaluation and model promotion.
Context 0.3 adds optional typed tool facts and context `role`/`requires` fields.
Grafly forwards supplied fields without guessing roles, dependencies or permission.
Command proposals describe the actual executable, argv, working directory and
execution effect; scope constraints remain unknown. Only actual failed command
output receives a failure role. Credential screening includes typed metadata.
The harness adds the Scope goal/constraints, calls MC `prepare` once, and gives
the same complete prepared input and hash to MC and JEV. Older MC retains the
legacy request and existing guards; Grafly does not prepare independently.
Production paired JEV signals may train unapproved MC candidates. Promotion still
requires independently verified gold validation and a fresh audit; a teacher
signal alone cannot approve a model.

The managed resolver supports exact API1–4 contracts and API5's 19-file bundle,
including `morecoffee/model_delivery.py` and `learning_service.py`. API4/5 smoke checks cover
the three new tasks, protected evidence, violated/unknown tool constraints,
input/feedback hashes and disabled collection. Unsupported future APIs preserve
the previous verified runtime. Grafly's watcher updates code and approved models;
the independent MC service owns every learning cycle.

The trusted user file `~/.grafly/comparison.json` contains
`schema: grafly.comparison.v1`, `enabled: true` and absolute paths `python`,
`runtime_root` (managed harness releases), `service_root` (existing CLI broker),
and `state_root` (harness model/Scope state). `GRAFLY_JUDGMENT_CONFIG=0` disables
this producer; a different absolute config path is useful for isolated checks.
Basic/GPT-only model settings cause no submissions.

`grafly run` observes proposed commands and completely captured small text output;
`grafly read` observes the displayed document/excerpt. It does not intercept every
host command or the entire LLM message. No active session/Scope means no judgment.
Original outputs, exit status, archives, permissions and conditional-read behavior
remain authoritative. Comparisons are advisory and do not remove content.

Large/binary/partial output is not silently shortened for comparison. Failure
output and stderr blocks are protected. Obvious credential files/material are
skipped. Raw input is sent to the configured JEV provider only in JEV/both mode;
frozen v2 feedback stays feature/hash-only. With MC's advertised
`mc.context.explanation.v1` capability, the harness additionally stores the full
shared input, both receipts and a separate observable JEV criterion judgment in
the local MC learning store. JEV's actual model version is pinned; this extra
Choice request is not an internal reasoning trace or verified truth. Criterion
conflicts quarantine teacher targets, and criterion types balance learning within
problem groups. No teacher answers enter inference features. Failed/uncertain
reasons are retained as missing/uncertain, never invented; oversized/sensitive
inputs are skipped without truncation. This adds background API work/cost and
does not train in Grafly. Consumer receipts/status do not retain raw input, and
Oracle receives no episodes. Without this capability, collection remains v2-only.
The producer stores only a small local
submission status. The broker keeps its normal bounded background admission.
An unavailable/busy broker or an expired session does not fail the original task.

Submission waits at most 750 ms for a local acknowledgment, never for model
completion. The current active immutable harness release is selected per
submission without changing any host session pin. The shared MC learned model
is read for the next request; consumers do not copy Python engines or trainers.
Learning uses the local learning home; inference uses the separate `MC_MODEL_HOME`.
Oracle distributes signed code and approved model artifacts. Local feedback and
datasets are not uploaded. See [runtime delivery](MC_RUNTIME.md) for verification,
revocation, status hashes and service migration.
