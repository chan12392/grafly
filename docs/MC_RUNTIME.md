# Oracle MC runtime

MC runtime API5 supplies the independent MC learning service and model validator.
`grafly mc-runtime resolve` returns a verified root/Python/public
metadata as `grafly.mc-runtime.resolution.v1` without network or writes, for the
harness managed consumer. It ignores the development MC_ROOT override. Missing or
invalid managed roots return a JSON error and nonzero exit.

Grafly consumes inference models and submits feedback; it never starts training.
`learning-status` reads `morecoffee.learning_service status` through the verified
API5 runtime. Former `learning-configure` and `learning-cycle` actions fail with
`mc_learning_mc_owned`. MC's `MoreCoffee-Learner` scheduled task owns collection,
training, independent evaluation and publication. Install and verify that service
before replacing an old Grafly watcher, so its feedback inbox continues to drain.
Only approved parameter artifacts and provenance hashes are published; local
datasets, source text and feedback rows stay local. See MoreCoffee
`MC_INDEPENDENT_LEARNING.md` and `docs/LOCAL_LEARNING.md` for the gates.

Code and model updates have independent sequences and download endpoints. The
watcher polls `/v1/models/stable` even when code updates fail or have no release.
It verifies the enrolled Ed25519 signature and artifact/model hashes, then calls
the pinned MC `model_delivery.validate_bundle` pure validator for exact feature,
schema, policy, scorer and recorded evaluation compatibility. Complete valid
artifacts activate atomically; rejected or interrupted replacements retain the
last good models. A 404 means no approved publication yet, not a trained model.
Artifact/model bounds are 128 KiB/16 KiB; signed manifests/envelopes have separate
256 KiB/384 KiB limits so cumulative revocations do not overflow the reader.

Inference uses `MC_MODEL_HOME` (default `~/.morecoffee/models`), separate from
`MC_LEARNING_HOME` (default `~/.morecoffee/learning`). The updater writes immutable
`models/<sha256>.json` files and atomic `current.json`/`revocations.json` pointers;
it retains signed evidence in `releases/` and `bundles/`. A verified newer cumulative
revocation list applies before downloading its replacement: revoked models stop
immediately, unrelated tasks keep their last valid model, and replay cannot restore
a revoked hash. Disabling learning or changing its `active.json` cannot alter
inference. Cache roots must be absolute and must not be symlinks or the learning home.
`grafly mc-runtime status` reports `models.home`, sequence, artifact hash and each
active task's `model_sha256`/`dataset_sha256`, without enrollment credentials.

Resident `callers` requests run the real CLI in a fresh, serialized child process.
Each judgment pins the current verified MC runtime and installed approved model, so the
next request sees updates without restarting the resident service. Running judgments
keep their original pin. This costs one process startup and graph load per `callers`
request; `ask`, `grep` and `build` retain their resident caches. Restart a resident
service predating this change once with `grafly daemon restart`.

Resident requests forward `MC_MODEL_HOME`, `MC_MODEL_DISABLED`, `MC_LEARNING_HOME`, `MC_ROOT` and
`MC_PYTHON` from the calling process and restore the service environment afterward.
The model home selects inference; the learning home selects only the feedback inbox.
The resolver schema stays unchanged; managed Python consumers inherit this environment.

The output runner can use a signed MC release independently of a MoreCoffee
checkout. This is a separate update path from Grafly/npm upgrades and does not
require or change MCP configuration.

An administrator enrolls a machine with an ACL-protected
`~/.grafly/mc-runtime/config.json`: HTTPS `url`, read-only `token`, trusted Ed25519
`publicKey`, absolute Python 3.11+ `python`, and `minimumVersion`. Obtain the key
through the trusted enrollment channel, never from the download endpoint.
The publisher is documented in MoreCoffee's `docs/CHANNEL_RELEASES.md`.

```
grafly mc-runtime status
grafly mc-runtime sync
grafly mc-runtime watch
```

The lightweight equivalent is `node <grafly>/dist/mc-runtime/cli.js <action>`.
On Windows, `scripts/install-mc-updater.ps1 -NodePath <absolute-node>` replaces the
current-user `Grafly-MC-Updater` logon task and restarts it through the packaged
`launcher.py` with `pythonw` and a hidden Node child. It stops an old wrapper/task
and its matching watcher before starting one replacement. Pythonw defaults to the
enrolled Python's sibling executable; `-PythonwPath` selects another installed one.
The launcher keeps stdout/stderr and exit status in `watcher.stdout.log` and
`watcher.stderr.log` in the runtime cache and restarts a failed child. On other systems,
run `grafly mc-runtime watch` in a user service. All updated Grafly installations
running as that user share the same cache and need only one watcher. Each other
PC/user must be enrolled once and have this updater-capable Grafly code installed.
Installing a GitHub release cannot retrofit an older CLI by itself.

The watcher reacts to Oracle release notifications and checks every minute as a
fallback. Offline machines catch up on reconnect/startup. Only stable signed
compatible releases activate. Bad signatures, file changes, unexpected Python
files/bytecode, path traversal, old sequences and version substitutions fail
closed. Failed downloads/tests retain the last good version. A damaged active
runtime produces raw output, preserving the original command's behavior.

Channel release numbers are not an acceptance list: newer stable implementation
versions activate when their signed metadata, runtime API/file set and existing
wire contracts remain compatible. Before switching, isolated seed probes check
tool-output response identities and bounded extraction, the symbol artifact schema
and nonempty candidate shape, and a verified quality improvement alongside
incomplete evidence and missing/stale/rejected reviews. Actual channel versions must match the signed
metadata. Failed probes preserve the active runtime and local learning state;
unknown runtime APIs or wire schemas still require a consumer upgrade. Restart
the watcher once after this Grafly upgrade to load the compatibility checks.

This managed update path supplies `tool_output`, `symbol_disambiguation` and
`patch_quality`. Optional `code_relation` escalation still uses its separately
configured trusted full-source installation; these bundles do not update it.

The active pointer switches atomically; each command pins its starting version.
Python runs isolated with site loading and bytecode writes disabled. No network
lookup, updater process spawn or synchronous download occurs in the output runner.
The signed metadata is also recorded as `mc_runtime` in raw-output receipts.

The initial package supplies `tool_output` and its common runtime only. It records
all channel versions but does not ship other channels/models or change opt-in
`GRAFLY_MC_HOME` code-relation escalation. `MC_ROOT` remains an explicit local
development override; an explicit `MC_PYTHON` retains precedence over the enrolled
Python executable. Without enrollment, the previous sibling-checkout behavior
is preserved. With enrollment, missing/invalid managed versions fall back to raw
output rather than silently using a development checkout.

`GRAFLY_MC_RUNTIME_HOME` can select another trusted cache (for isolated tests or
operators). Never derive it or `MC_ROOT` from an untrusted repository. The cache
must be writable only by the enrolled user and its administrators. Versions are
retained; do not delete them while commands are running.

Stop automatic updates on Windows with `Stop-ScheduledTask -TaskName
'Grafly-MC-Updater'` and `Disable-ScheduledTask -TaskName 'Grafly-MC-Updater'`.
Existing verified code remains usable offline. Rollback is a newly signed higher
release containing the previous rules; do not lower local sequence state.

The background watcher also enforces the local raw-output archive's 20 MiB
budget every minute, including while Oracle is unreachable. Active writers are
protected; finished and crashed writers are cleaned oldest-first. See
[tool output retention](TOOL_OUTPUT.md). Restart an existing watcher after a
Grafly code update to load this maintenance loop; MC bundle updates do not
replace the Grafly executable.

Focused verification: `node --test test/mc-runtime.test.mjs test/mc-models.test.mjs
test/mc-learning.test.mjs test/mc-compatibility.test.mjs test/resident-env.test.mjs
test/mc-updater.test.mjs test/tool-output.test.mjs test/tool-output-retention.test.mjs`.
Set `GRAFLY_TEST_MC_SOURCE` and `GRAFLY_TEST_PYTHON` to exercise the actual signed
API5 package, publisher HTTP endpoints and hidden launcher in isolated temporary
caches. Synthetic test models never enter the production cache or publisher.

MC 0.6 keeps API5 and its 19 files. Model manifests/bundles retain outer scorer
`mc.context-judgment.v1`; individual context models may use v1 or v2. Grafly
delegates exact model validation to the signed MC `validate_bundle`: v1 has
eight weights and nine learned parameters; v2 has those eight plus
`ordered_00`–`ordered_63`, `fit.class_weight: balanced` and 73 parameters.
Seeds report zero. Unknown profiles, missing/extra weights or invalid fit
metadata leave the last valid model pointer intact; signed revocations still
apply before replacement validation. No feature encoder or trainer is added here.
