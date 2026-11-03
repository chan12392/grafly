# MC analyzer and installed host routing — 2026-09-22

The local installations now use the MC source-evidence analyzer and automatic
command rewriting in Codex, Hermes and Devin. MCP is not required.

## Analyzer

`grafly mc-analyzer configure --home <trusted-mc-installation> --python <absolute-executable>`
saves `~/.grafly/mc-analyzer.json`. `status` reports the effective configuration.
It is read at invocation time, including from processes that never inherited
`GRAFLY_MC_HOME`. Environment overrides and existing kill switches still work.

`grafly callers` automatically submits ambiguous dropped call sites to the
configured `code_relation` channel. `grafly mc-analyzer judge --root <repo>
--file caller.py --candidate alpha.py#work --candidate beta.py#work` explicitly
queries the same analyzer. Results retain static-evidence limitations and abstain
when evidence cannot distinguish candidates. This does not replace the whole
Grafly graph builder, nor make every `ask`/`grep` call run a full MC analysis.

The installed channel is `code_relation 0.3.0`. A real three-file fixture picked
`alpha.py#work` from two same-name candidates using import evidence. First call
scanned sources; the next used `snapshot_cache`. A real `grafly build` produced
an ambiguous `work()` site and `grafly callers work --json` resolved it through
MC. Python starts isolated, never imports the scanned repository, and has a
bounded timeout. Engine-source fingerprints separate caches after MC upgrades.

This analyzer currently loads the explicitly configured local MoreCoffee
installation. Oracle stable 0.2.1 only delivers `tool_output`; it does not ship
the full improved analyzer. This work does not publish a new stable release.

## Installed routing

| Host | Native contract | Verified boundary |
| --- | --- | --- |
| Codex | PreToolUse, `updatedInput` + `permissionDecision: allow` | Fresh native app-server, unwrapped test command, 180-test reduced result before next model request; original transcript archived once. |
| Hermes | Plugin `pre_tool_call`, `action: modify`, merged args | Installed plugin discovery and actual terminal backend; unwrapped rg result reduced from 350 to 200 lines. |
| Devin | PreToolUse, merged `updatedInput`, no approve decision | Fresh real CLI; native README read passed; unwrapped rg reduced from 701 to 200 lines with receipt. |

Codex rewriting is restricted to already non-asking `dontAsk`/`bypassPermissions`
sessions because its protocol requires an allow decision. Default/plan modes
keep normal permissions and the manual wrapper guidance. Default and active
Orca homes have respectively 12/12 and 32/32 trusted hooks; fresh CLI startup
showed zero hook-review warnings in either home.

Only a single, literal, recognized external command is rewritten. All arguments,
cwd, timeouts and tool settings remain intact. PowerShell preserves the process
exit code explicitly; Hermes and Devin use Bash even on Windows. Aliases, shell
expressions, pipelines, redirects, substitutions, multiline commands, TTY and
background processes stay with the host. Windows npm/pnpm/yarn .cmd shims stay
with the host. Native Read/Grep tools are not converted into other tool names.
PowerShell read paths with wildcards (even quoted), provider prefixes, or
drive-relative syntax stay with PowerShell so its path resolution is preserved.
`GRAFLY_NO_TOOL_ROUTE=1` disables automatic rewriting.

Devin's old installed shim blocked Read/Grep/Find until a session marker recorded
one graph consultation. That rule covered README and PRODUCT too, explaining
the screenshot. It has been removed; the shim now dispatches the rewriting hook
and returns an empty allow-through response for native reads.

Existing open processes may cache registrations or Python plugin modules. Start
a new host session to load a newly registered hook/plugin. This is separate from
the verified installed files and fresh execution paths above. Other hosts were
not enrolled. The existing 20 MiB raw-output retention policy remains in force.

## Distribution protection target

The goal is to make reverse engineering expensive. The main protection should
cover MC; Grafly's host adapters and channel interfaces can stay inspectable.
For a later release, compile the MC analyzer into a platform-specific native
module/executable, strip debug symbols and source maps, omit Python sources,
training/evaluation data and developer caches, and keep the existing signed
manifest/hash/atomic-activation checks. Test behavioral parity before promoting
each OS/architecture artifact. Python bytecode or a onefile archive alone is not
the intended protection. The local integration and current portable release are
still source-based; a compiled/obfuscated release has not been produced here.

Backups and acceptance records:
`C:/Users/example/.grafly/install-backups/20260922-185740-mc-host-routing/`.
The native Codex loopback fixture record is under
`C:/Users/example/AppData/Local/Temp/grafly-output-native-kWrpuR/`.

## Conditional read boundary — 2026-09-29

Read deduplication requires an enclosing Grafly index and a request-bound,
host-prefixed session identity. Missing identity or an unindexed directory
returns content normally. Changed files are read normally; only an unchanged
whole-file receipt can suppress repeated content. No file snapshots are saved.

The native gate recognizes only Devin `read` with `file_path`; `offset` or
`limit` bypasses it. Files over 20,000 bytes pass through. Native pre-tool calls
never establish read receipts: approval and delivery have not happened yet.
Only a completed Grafly whole-file response can justify a later native denial.
A retry passes; Codex/Hermes native tools and unverified tool aliases pass.

Earlier real Codex and Devin sessions verified session isolation for unwrapped
shell `cat` through disposable host configurations. Those checks did not prove
native read-gate delivery, already-open Orca registrations, or live Hermes
behavior. The review regression tests cover the current gate and shell routing
contracts; they are not new live-host acceptance evidence.

The read-state cache holds hashes only, expires receipts after 24 hours, and
retains at most 32 sessions and 60 paths per session. Pruning occurs on writes.
A separate cache lock prevents conflicting updates and atomic replacement avoids
partial JSON; lock contention skips caching. Legacy pre-tool receipts are ignored.
