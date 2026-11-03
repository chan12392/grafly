# Command output before model delivery

Automatic rewriting is now installed for Codex, Hermes and Devin through the
separate `route-hook.js` adapter. Supported literal terminal commands are routed
without model adherence; native Read/Grep, complex shell and interactive calls
remain with the host. See [host routing and actual acceptance](MC_HOST_ROUTING.md)
for approval-mode restrictions and installation evidence. `output-hook` itself
continues to install guidance only.

Conditional file reads use a request-bound session identity. Host adapters pass
`<host>:<session_id>`; direct CLI users can pass `--session-id <id>` or set
`GRAFLY_SESSION_ID`.
Missing host identity disables read deduplication, including when the parent
environment contains another session's ID. Native ranged reads always pass
through. Changed files return their requested content normally; no snapshots or
hunk diffs are stored. Hash receipts require an enclosing index, expire after
24 hours and are capped at 32 sessions with 60 files each. Updates use a separate
cache lock and atomic writes; contention returns normal content.
`grafly read --fresh` forces full content in both CLI entrypoints.

See [host routing](MC_HOST_ROUTING.md) for the native read boundary and prior
multi-host acceptance evidence.

```powershell
grafly run -- python -m unittest -v tests.test_example
# In a PowerShell tool invocation, propagate the native status:
exit $LASTEXITCODE
```

`grafly run -- <executable> <args...>` runs the process exactly once, inherits
stdin/environment/cwd, and captures stdout and stderr independently. Arguments
are passed as an array with no extra shell interpretation. Supply an executable,
not a shell builtin, `.ps1` or Windows `.cmd` script. Do not use this buffered
runner for interactive/TTY commands. For shell syntax use an explicit shell;
such commands pass through unreduced.

The `runCommand` API accepts MC's optional `required_stdout_ranges`,
`required_stderr_ranges` (up to 64 zero-based LF-line `[start,end)` ranges per
original stream), and `focus_terms` (up to 16 literal strings, 256 UTF-8 bytes
each). It also forwards the actual pattern for simple `rg`/`grep -F` and `fgrep`
calls; regex and ambiguous option forms do not invent literal hints. The consumer
checks required/focused original lines before applying a reduction. Unsupported
MC, omitted required lines or rewritten coordinates fall back to the complete
raw streams. Archives and `grafly output --find`/range retrieval remain available.
Direct bounded `grafly read` requests already return the requested original ranges.

Recognized kinds and their bounded results:

- `test` — `python -m unittest`, `python -m pytest`, `pytest`, `node --test`,
  and direct `npm test` / `pnpm test` executables where available. Passing
  unittest/Node TAP/pytest detail lines are removed; warnings, skips and totals
  remain verbatim.
- `read` — `cat`, `head`, `tail`, and `git show REV:PATH`. Keeps the first 200
  stdout lines verbatim and, with MC tool-output 0.3, the last 40; stderr stays raw.
- `search` — `rg`, `grep`, `egrep`, `fgrep`, `findstr`, `find`, `ls`, `where`,
  `which`, `tree`, `git grep`, `git ls-files`, and listing-only `git diff`/`show`
  forms (`--name-only`, `--name-status`, `--numstat`, `--shortstat`, `--stat`,
  `--raw`, `--dirstat`, `--summary`, `--compact-summary`). A stream that is
  entirely `path:line:text` hits is deduplicated losslessly first — each file's
  path prints once as a group header with its `line:text` hits beneath (the
  same layout ripgrep uses on a terminal), bounded at 200 emitted lines;
  anything else keeps the first 200 stdout lines verbatim. stderr stays raw.
  Exit 1 is a no-match result only for
  `rg`/`grep`/`egrep`/`fgrep`/`findstr` and `git grep`, with empty stderr.
  Other commands such as `find`/`ls` keep nonzero output entirely raw.
- `git` — `git status`, `git log`, `git diff`, `git show`. Diffs keep the first
  400 lines plus every later file's `diff --git` line and its critical status
  lines (rename/copy/mode/binary/unmerged), including rows crossing the prefix
  boundary and standalone `* Unmerged path` rows; `index`/`---`/`+++` bookkeeping is
  capped at 100 omitted files. Status keeps sections, conflicts, unmerged and
  rename entries while plain entries are capped at 100. Full `git log` keeps 30
  entries plus every later commit id; oneline keeps 100 rows. Stderr stays raw.
  `git diff` exit 1 with no diagnostics means differences, including listing
  forms; it is never labeled "no matches".
- `build` — `npm`, `pnpm`, `yarn` with `install`/`i`/`ci`/`add`/`remove`/
  `update`/`upgrade`. Drops only recognized `npm verbose|verb|info|http|timing|
  sill|silly` lines and superseded pnpm `Progress: resolved` rows. Warnings,
  errors, notices and summaries remain verbatim. On Windows these package
  managers are `.cmd` shims, not spawnable executables — the runner declines
  (exit 127) and the command should be run directly, passing through raw.

Command names and MC's recognized formats must both match; unknown output,
failures, interrupted commands, binary data, side-effecting commands
(`git commit`, `git merge`) and shell-wrapped invocations pass through raw.
Output below 4 KiB bypasses MC; above 4 MiB it streams raw rather than growing
the buffer or truncating evidence. Combined streams above 8 MiB exceed the MC
transport and also pass through raw.

MC stays the sole rules engine. The runner passes `exit_one_is_result` only for
the command-specific exit-1 cases above; MC defaults this exception to false.
Configure `MC_ROOT` to a trusted MoreCoffee
checkout or install MoreCoffee in `MC_PYTHON` (default `python`). The sibling
MoreCoffee checkout is discovered automatically. Isolated Python startup avoids
importing code from the executed command's working directory. Missing MC,
timeout, invalid output/ranges or failed archive writes cause raw passthrough;
the original command is never retried. A missing executable returns 127.

Raw data is stored under `~/.grafly/tool-output/<uuid>/` (override with
`GRAFLY_OUTPUT_DIR`): `stdout.bin`, `stderr.bin`, `manifest.json`. The manifest
records exit code, completion, byte counts and SHA-256. Compression is committed
only after raw streams and manifest are saved. Archives share a 20 MiB retention budget.
The manifest also records `mc_attempted`, `mc_reason_codes` when available, and
a specific `reason` for raw fallback; see [log reasons](MC_FEEDBACK.md).
Within-stream bytes/order are retained; no combined stdout/stderr chronology is
claimed. These local archives can contain the same sensitive content as the
original command output.

The budget covers raw streams and per-record metadata across all Grafly CLIs
using the same archive root. Finished records are removed oldest-first until
the total fits. There is no age expiry and no per-command output cap. A live
writer is protected even when the total exceeds 20 MiB; silence alone does not
mean a running command has stopped. Completion marks the writer finished.
After a crash, a writer whose process no longer exists becomes eligible.

Cleanup runs before and after commands. The enrolled `mc-runtime watch` worker
also sweeps once per minute independently of its network connection, so idle
sessions and disconnected Oracle updates do not block cleanup. Without that
worker, the next command or `grafly output-prune` performs cleanup. The background
worker must restart once after a Grafly code upgrade to load this behavior.

```powershell
grafly output-prune --dry-run  # size, protected bytes and proposed removals
grafly output-prune            # apply the same 20 MiB policy immediately
```

Deletion is restricted to validated UUID archive directories and known regular
files; junctions, symbolic/hard links and unexpected children are protected.
Ownerless legacy partial archives and corrupt ownership metadata are also
protected because their inactivity cannot be established. This can keep usage
above the budget. Interrupted deletions are retried. These rules do not delete
chat histories, repository files or MC release versions.

Once a record expires, its ID no longer retrieves the original output; lookup
reports that it may have expired. A single finished output larger than 20 MiB
can expire immediately, after its complete output has been delivered. Any such
immediate expiration is printed explicitly. Counts are file-content bytes, not
filesystem allocation units, and active writers may temporarily exceed them.

```powershell
grafly output <uuid> --find 'test_runtime_audit_' --context 0
grafly output <uuid> --find 'warning' --context 2 --max-matches 5
grafly output <uuid> --stream stderr --start 20 --count 30
grafly output <uuid>                              # explicit full raw retrieval
grafly output <uuid> --archive-dir C:\my-archives
```

Use `--find <literal>` first when a follow-up needs omitted details. It searches
both streams, case-sensitively without regex interpretation, and returns
`stream:line:text` with one surrounding line by default. Overlapping context is
deduplicated. Defaults are 20 matching lines across streams and an 8 KiB response
budget including metadata. `--context 0` retrieves only the matching lines.
Warnings, skips and totals already retained in the execution result normally
do not require another lookup.

Each selected stream reports matching lines from `--start` onward, lines shown,
and `complete`. Zero matches is explicit. For a limited result, `next_start`
identifies the first missing match in that stream: repeat the same literal with
`--stream <name> --start <next_start>`, or narrow the literal. If the byte budget
cannot fit a complete context window, the result says so; reduce `--context`
or explicitly raise `--max-bytes`. It never silently clips a matching line.
Limits are context 0..20, max-matches 1..200, and max-bytes 1024..1048576.
The header and per-stream stats count toward the same budget, and a match
window that could never fit the budget is a loud error rather than a skipped
line. `--count` is for raw line ranges and cannot be combined with `--find`.

Retrieval reads and verifies the complete selected streams against their
manifests before returning evidence. This bounds model-facing search output,
not local archive I/O or memory use. The lightweight host entry point supports
the same `output` options as the public CLI. A reduced result includes the
retrieval ID and search/range syntax, so archive listing or manifest dumping is
unnecessary. Full raw retrieval remains available for explicit evidence needs.
Reported input/output sizes are bytes, excluding the receipt; they are not
measured model tokens, billing savings or a reasoning-quality guarantee.

## Reading files and directories

```powershell
grafly read <path>                      # first 200 lines with path:line header
grafly read <path> --start 300 --count 50
grafly read <path> --find 'needle' --context 2
grafly read <dir>                       # bounded sorted listing, dirs end with /
```

`read` is the bounded counterpart of `Get-Content`-style file access: no command
runs, so it needs no shell and works on paths with spaces or Unicode. Ranges are
verbatim (CRLF preserved), always carry the absolute path, shown range and a
`continue:` hint when incomplete. `--find` shares the archive literal-search
contract (case-sensitive, match/context/byte budgets, `next_start`). A ranged
read delivers whole lines within a 1 MiB response budget including its header;
a single line over budget is a loud error, never a silent clip. Directory
listings honor `--max-bytes` including their header and continuation, emit only
whole entries, and reject an entry that cannot fit. Search-only options require `--find`; directory content search
is unsupported. Binary (invalid UTF-8 or NUL-containing) and >256 MiB files are
refused. The lightweight host entry supports `read` identically.

## Codex / Orca host

```powershell
grafly output-hook                                # active CODEX_HOME
grafly output-hook --home C:\specific\codex-home
grafly output-hook --remove
```

On Orca, the account home can be regenerated from the default Codex home when
opening a terminal. Installing only in `ORCA_CODEX_HOME` is not persistent.
Install in the source home as well as the active account home:

```powershell
grafly output-hook --home "$env:USERPROFILE\.codex"
grafly output-hook --home "$env:ORCA_CODEX_HOME"
```

Review the exact native `hooks/list` keys and hashes for both paths. Orca can
also refresh account configuration from the default home, so the reviewed trust
entries must survive that refresh. Verify again after creating a new Orca
terminal; a successful install before that step does not prove persistence.

The installer preserves existing hooks and backs up `hooks.json`. It appends
SessionStart/UserPromptSubmit guidance instructing the agent to use the runner
through its normal shell tool, including leaf `tools.exec_command` calls inside
`functions.exec`. Follow-up guidance prioritizes literal search and bounded
line ranges instead of rereading entire archives or rerunning tests. A new
host session loads the hooks; native hook review/trust
is still managed by Codex. `GRAFLY_TOOL_OUTPUT=0` suppresses this guidance and,
in the runner itself, disables archiving and reduction entirely — `grafly run`
becomes a plain streaming passthrough. `GRAFLY_NO_TOOL_ROUTE=1` stops host
hooks from rewriting commands through `grafly run` in the first place.

This is **agent-directed routing**, not automatic interception of every `Ran`
result. The agent must use `grafly run`. Codex 0.155.1 rejects PreToolUse
`updatedInput` without `permissionDecision: allow`; Grafly deliberately does
not add a global permission grant. Normal tool approval and sandbox paths stay
in use. No provider proxy or existing session history is modified.

`node --test test/tool-output.test.mjs` covers execution, kind classification,
fallback, retrieval, exit codes, `read` and hook installation. With `GRAFLY_TEST_CODEX=<native executable>`,
`node --test test/tool-output-native.test.mjs` exercises actual Codex app-server
and a loopback Responses fixture: guidance reaches the first request; the
fixture calls the runner; the next request contains reduced output. This proves
delivery, not autonomous adherence by a real model or the already-open Orca UI.

The old `session-live`, `session-compact`, `session-expand` and MC session host
are removed. Existing rollouts, manifests and archive files remain untouched.
# Signed MC runtime updates

Enrolled clients use Oracle's verified stable MC output runtime. See
[MC runtime](MC_RUNTIME.md) for enrollment, the watcher, security and offline behavior.
