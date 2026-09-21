# Hermes automatic retrieval (opt-in)

`node /absolute/path/to/grafly/scripts/grafly-hermes-hook.cjs` is a native
Hermes **`pre_llm_call` shell hook**, not a Claude/Codex response shim or an MCP
server. It reads existing Grafly indexes and returns only `{"context":"..."}`.
An empty stdout and exit 0 mean no injection. Node >=22.12.0 and the Grafly
package's installed dependencies are required; keep the script beside `dist/`.

## Protocol and turn semantics

The adapter consumes Hermes's actual shell payload:

```json
{
  "hook_event_name": "pre_llm_call",
  "session_id": "session-a",
  "cwd": "C:/work/project",
  "extra": {
    "turn_id": "session-a:task-a:turn-a",
    "user_message": "Where is authenticateUser implemented?",
    "conversation_history": [],
    "is_first_turn": true
  }
}
```

Hermes `agent/shell_hooks.py::_payload_fields` puts event-specific kwargs under
`extra`; `cwd` is the shell bridge's process working directory. Do not infer a
project from the global MCP server, the prompt text, or a different host's env.
In Hermes `agent/turn_context.py::_collect_pre_llm_call_context`, called during
turn preparation **before** the conversation/tool loop, `pre_llm_call` fires
once per `run_conversation()` / user turn, not once per model API request.
`is_first_turn` means first turn of the **session**, not first tool-loop call;
it must not disable retrieval for later user turns. Hermes joins all returned
context fragments and appends them to the current user message, leaving the
system prompt and the other hooks' context intact.

The adapter additionally claims `(session_id, extra.turn_id)` atomically for
replayed or simultaneous deliveries. Different sessions and turns are distinct,
even when the prompt is identical. Missing/invalid identities skip retrieval
rather than guessing from prompt text. This requires a Hermes release that
supplies `turn_id`; older releases without it are intentionally silent.
Only string user messages are supported; unsupported/multimodal shapes skip.

## Retrieval and boundaries

- Walk upward from absolute `cwd` to the nearest existing `grafly/` index
  (legacy `graft/` also works). Stop at a `.git` directory **or worktree file**
  before inheriting an index from another checkout.
- Never inherit the user's home index from a nested, unindexed directory.
  Starting explicitly in the home directory can use its saved workspace.
- Saved `workspace.json` children are queried via shared `federateAsk`; ordinary
  repos use shared `ask`. A workspace must be version 1, nonempty, and contain
  relative child paths without parent traversal. Missing children are skipped,
  not discovered, created, or built. Workspace child indexes use the engine's
  canonical `grafly/` layout; legacy standalone indexes remain supported.
- The same prompt gate as the clean Codex/Devin reference skips recognizable
  conversation (including Korean) but keeps short identifiers and mixed tasks.
  Shared `relevantRetrieval` applies the existing strength gate and formats up
  to three ranked pointers. Formatting/novelty state is fresh for each user
  turn; a deliberate repeated question can receive the pointers again.
- No CLI startup, Claude lifecycle hook, upkeep, refresh, rebuild, update check,
  telemetry sender, Brain upload, or agent wiring is invoked. No network or
  child command is needed. Existing saved indexes can be stale: verify source
  before editing; perform any desired refresh separately and explicitly.
- Concept frontmatter on the shared `ask` / `federateAsk` retrieval path is
  data-only: default YAML, explicit YAML/YML, or JSON. Executable and unknown
  engine labels are rejected before gray-matter dispatch; options bypass its
  shared parse cache without mutating global engine registrations. An invalid
  concept can suppress that repo's retrieval (the hook fails open); workspace
  federation may still return other valid children. The same data parser and
  ordinary concept ranking/formatting remain in use.
- `GRAFLY_DIR` / `GRAFT_DIR` do not redirect this hook to a different project.
  Project selection is exclusively the payload's `cwd` and saved indexes.

Only empty claim files are written, under
`<index>/.cache/hermes/<sha256(JSON([session_id, turn_id]))>.seen`. Identifiers
are never path components. No raw prompt, history, session ID, or retrieved text
is persisted by the adapter. Claims are made before retrieval, so a failed or
timed-out attempt is not retried on the same turn. The cache can be removed
when sessions are no longer active; removal permits old deliveries to replay.
It is not garbage-collected automatically (one empty file per attempted turn).
Read-only/unavailable claim storage fails open without injection.

## Bounds and failures

The watchdog runs separately from synchronous disk reads/ranking in a worker
thread. It also covers a stalled stdin stream. The default and maximum deadline
is 6000 ms; `GRAFLY_HERMES_TIMEOUT_MS` can shorten it. Configure an 8-second Hermes
shell timeout to leave startup/exit headroom. Input exceeding 1 MiB (including
history) is discarded. Context is capped at 8000 JavaScript characters with an
explicit truncation marker. Malformed JSON, corrupt indexes, missing dependencies,
worker errors, state errors, and deadline expiry silently fail open.

The adapter cannot sandbox a malicious installed Node package or preload. Review
its package/dependencies as you would any shell hook. Large histories or graphs
may cause a safe skip; this is preferable to blocking a user turn.

## Additive registration — no other hosts or plugins changed

Registration is intentionally manual/opt-in. Do **not** run `grafly init`, migrate
other host registrations, replace the complete `hooks` mapping, disable Baekho or
Ponytail, or enable blanket `hooks_auto_accept` just to install this adapter.
Use the intended Hermes profile (`HERMES_HOME` / Hermes profile selection).

1. Back up that profile's config and allowlist. Inspect the current event list:

   ```sh
   hermes config path
   hermes config get hooks.pre_llm_call --json
   hermes hooks list
   ```

   If the key is explicitly reported as not set, start with an empty array.
   Other errors must be resolved, not treated as an empty configuration.

2. Copy the **entire existing `pre_llm_call` JSON array unchanged**, and append
   exactly one entry like this (replace both absolute paths with installed
   paths; Windows forward slashes avoid shell quoting ambiguity):

   ```json
   {
     "command": "\"C:/path/to/node.exe\" \"C:/path/to/grafly/scripts/grafly-hermes-hook.cjs\"",
     "timeout": 8,
     "fail_closed": false
   }
   ```

   Save the complete merged array through the supported CLI:

   ```sh
   hermes config set hooks.pre_llm_call '<complete merged JSON array>'
   hermes config get hooks.pre_llm_call --json
   ```

   The angle-bracket text is a placeholder, not a literal command value. In
   particular, never set a Grafly-only array if existing shell hooks are present.
   If the exact command is already present, do not append it twice. This changes
   only this event's list; Ponytail's plugin registration and
   `pre_gateway_dispatch`, Baekho, other events, and MCP configuration stay as-is.

3. Start a new interactive Hermes session and approve **only this exact**
   `(pre_llm_call, command)` pair at first use. For noninteractive deployments,
   merge that exact pair into the profile's existing
   `shell-hooks-allowlist.json` `approvals` array without removing entries;
   follow Hermes's shell-hook consent documentation. Do not auto-approve other
   configured commands. Restart the relevant runtime after registration.

4. Read back the hook list and test with synthetic data:

   ```sh
   hermes hooks list
   hermes hooks test pre_llm_call --payload-file synthetic-hermes.json
   hermes hooks doctor
   ```

   `hermes hooks test` takes **hook kwargs**, not the nested wire envelope above:

   ```json
   {
     "session_id": "grafly-install-check",
     "turn_id": "fresh-check-1",
     "user_message": "Where is authenticateUser implemented?",
     "conversation_history": [],
     "is_first_turn": true
   }
   ```

   Run from an indexed project and use a query naming one of its actual symbols.
   The bridge supplies `cwd` and wraps kwargs under `extra`. Use a fresh `turn_id`
   for a new smoke test; repeating the same ID must be silent. The test command
   fires **every configured matching hook**, so use synthetic data and verify
   Baekho/Ponytail context is still present. A successful exit alone is not proof
   of retrieval: inspect the parsed Grafly `context` and actual file pointers.
   `doctor` uses generic input and may correctly see no retrieval.

Uninstall by removing only the exact Grafly entry from the event array via
`hermes config set`, and revoke only its exact command with `hermes hooks revoke`.
The implementation and tests do not register anything or change live config.

## Scope of this patch

The branch was fast-forwarded to `origin/master` `686866e` before final
validation. The shared prompt gate, ranking, federation, and formatting engine
are used unchanged from that base. The shared `ask` concept parser is narrowly
hardened to reject executable/unknown frontmatter engines. Other gray-matter
consumers (build/card/visualization paths) are outside this retrieval-only fix.
No dirty-checkout changes are imported.
See the validation record for the executed test results.
This is Hermes-native retrieval, **not** the Devin shim's automatic build path.

Run:

```sh
node --test test/hermes-hook.test.mjs
npm test
```

See `HERMES_HOOK_VALIDATION.md` for execution results and the RED/GREEN record.
