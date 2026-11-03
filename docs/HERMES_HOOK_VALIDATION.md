# Hermes retrieval hook validation

## Checkout and scope

- Workspace: `C:/Users/example/work/grafly-hermes-hook`
- Branch: `feat/hermes-retrieval-hook`
- Task-start base / unchanged HEAD: `14dc6cd1c3d1dd7139fe3145bf7bd8a18f7b396c`
- Runtime: Windows, Node `v22.23.2`.
- Dependencies reused through an ignored Windows `node_modules` junction to the
  clean reference worktree. No install/build lifecycle scripts were run.
- No commits, pushes, live Hermes config changes, or dirty-checkout edits.

## Executed RED / GREEN slices

Each implementation slice was preceded by an executed failing test, followed by
an executed passing focused suite. The failures were observed, not inferred:

| Slice | Observed RED | GREEN |
|---|---|---|
| Native wire + shared-engine retrieval | Adapter absent (`MODULE_NOT_FOUND`) | Actual `authenticateUser` pointer returned as `{context}` |
| Envelope validation | Wrong event still injected context | Wrong/malformed envelopes silent |
| Reused prompt gate | `prompt-gate.js` absent | Short/mixed tasks retained, conversation rejected |
| Adapter gate integration | Indexed symbol named `thanks` was injected | Conversation skipped before graph work |
| Project resolution | Nested cwd returned no indexed pointer | Ancestor lookup, Git/worktree boundary, explicit-home rule |
| Turn claims | Replayed turn returned context twice | Atomic hashed empty markers; new sessions/turns work |
| Hard deadline | Stalled stdin needed external kill; synchronous query reached 10-second test timeout | Watchdog ended both with exit 0 |
| Saved/legacy indexes | Workspace and legacy index returned no context | Shared federation and explicit legacy context path |
| Manifest safety | Invalid manifest created claim cache | Invalid/empty/traversing manifests skip before writes |
| Bounds | Over-1-MiB payload queried; giant title exceeded context cap | Oversized input silent; output <=8000 characters |

Additional regression assertions exercised corrupt graphs, unavailable state
storage, missing identities, concurrent delivery, Windows path separators, and
network/process-launch guards. Test fixtures use synthetic saved graph data;
no repository index was built or changed by the hook.

## Final executed results

| Command / comparison | Result |
|---|---|
| Baseline `node scripts/run-tests.mjs` before implementation | **36 passed, 0 failed** |
| `node --test test/hermes-hook.test.mjs` | **18 passed, 0 failed** |
| Full `node scripts/run-tests.mjs` (`npm test` entrypoint) | **54 passed, 0 failed** |
| `git diff --check` | Clean |

There were no baseline failures to carry forward. Captured TAP files:
`C:/Users/example/AppData/Local/hermes/cache/scratch/grafly-hermes-{baseline,focused,full}.tap`.

## Real Hermes bridge smoke check

Executed `verify-grafly-hermes.py` in the Hermes scratch directory using the
installed Hermes Python and current source, with a temporary isolated
`HERMES_HOME` and synthetic indexed project. The script called the actual
`agent.shell_hooks.run_once` (production serialization, subprocess spawning,
and response parser), not an invented protocol stub.

Results:

- `real_shell_bridge: pass`
- `replay_silent: true`
- `later_turn_retrieves: true`
- `real_context_aggregator_preserves_synthetic_siblings: true`
- Actual returned pointer: `authenticateUser · function: auth.js:L1-L3`.
- Actual `hermes config get` / `config set hooks.pre_llm_call` / readback under
  the isolated profile preserved both existing synthetic event entries and
  the separate `pre_gateway_dispatch` event.

The real `_collect_pre_llm_call_context` aggregator was exercised with synthetic
sibling hook returns. This is not a claim that live Baekho or Ponytail were run
by these tests; live integration is intentionally outside this worktree task.

## Final base reconciliation

After the initial implementation validation, the branch was fast-forwarded to
`origin/master` `686866e` (which includes the shared prompt gate, exact-symbol
retrieval, and startup dedup work). The identical prompt-gate copy was replaced
by its upstream tracked version; it is not a change in this PR.

Executed again against this base:

- `node --test test/hermes-hook.test.mjs`: **18 passed, 0 failed**.
- `npm test`: **94 passed, 0 failed**.

The initial baseline and RED/GREEN record above refer to the original base.
PR target remains **`chan12392/grafly`, branch `master` only**.

Remaining operational limitations are explicit in `HERMES_HOOK.md`: text-only
messages, turn-ID-capable Hermes, saved/stale indexes, 1-MiB whole-payload cap,
6-second deadline, and one empty dedup marker per attempted turn with manual
cleanup only after sessions are inactive. No live registration was performed.

## Executable-frontmatter security fix

The shared `ask` corpus loader previously passed saved Markdown to unrestricted
`gray-matter`, whose JavaScript engine evaluates frontmatter. This was reachable
through both ordinary repo retrieval and saved-workspace federation.

Executed security RED/GREEN slices:

- Initial adversarial run (`node --test --test-name-pattern='concept frontmatter'
  test/hermes-hook.test.mjs`): **0 passed, 2 failed** for the actual vulnerability.
  Both repo and workspace payloads wrote a marker and reached three guarded
  process/network calls. An earlier test-authoring run had incorrect expected
  pointer formatting; it was corrected before this vulnerability RED run.
- Initial allowlist GREEN: focused **20 passed, 0 failed**, full **96 passed,
  0 failed**. Added a double-BOM regression before correcting a normalization
  mismatch: observed **0 passed, 2 failed**, both due to marker execution.
- Final GREEN after preserving the original input for gray-matter's own single
  BOM normalization: `node --test test/hermes-hook.test.mjs` **20 passed,
  0 failed**; `npm test` **96 passed, 0 failed**.

Coverage includes default YAML, explicit YAML and JSON concepts (title, source
pointer, and prose preserved), JavaScript aliases/case/whitespace, unknown and
prototype-like engine names, BOM/CRLF inputs, and double BOMs on both retrieval
surfaces. Malicious payloads attempt a real marker write, child-process spawn,
HTTP access, and fetch. A child preload audits and blocks the latter operations,
so RED never launches the payload's process or makes its network request; GREEN
proves no marker or guarded call occurs. This is not an OS sandbox test.

The narrow fix explicitly validates the detected engine against YAML/YML/JSON
before dispatch and passes per-call data parsers/options, avoiding global mutable
engine overrides and the shared content-only cache. Unsupported frontmatter
rejects that corpus; existing hook/federation error handling remains unchanged.
Other gray-matter consumers outside `ask` are not hardened by this change.
No commits, pushes, dependency changes, or live configuration edits were made.
