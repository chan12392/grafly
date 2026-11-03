# Grafly

Grafly is an independent project built on Graft 0.18.0's engine, with a local
ambiguity-ranking circuit and a diverging roadmap. This repository is canonical —
there is no upstream remote, fork relationship, or sync channel to Graft. The
Graft graph/query engine remains the structural base; Grafly owns the product
name, CLI, cache directory and local ranking behavior.

## Quick start

Use Node.js >=22.12.0 and Git. Windows and Linux with Node 22/24 are the CI
targets. Native grammar installation may require Python and C/C++ build tools
when a compatible prebuilt parser is unavailable.

Install from the canonical source (these instructions do not assume an npm
registry release):

```sh
git clone https://github.com/chan12392/grafly.git
cd grafly
npm ci
npm link
cd /path/to/your/repository
grafly build
grafly ask "where is configuration loaded" --source
grafly callers yourFunction --depth all
```

Basic indexing and retrieval require no server, account, model key or MoreCoffee
installation. Rust is needed only to build optional embedded XERJ with
`npm run build:xerj`; the graph/lexical fallback remains available without it.
Packages contain source, not whichever native binary was on the publisher's PC.

Agent wiring is optional: preview `grafly init --dry-run`, then run `grafly init`
or explicitly run `grafly hooks`. Installation itself does not modify agent
settings. To remove the integration, preview `grafly uninstall --dry-run`, then
run `grafly uninstall`; stop a resident process with `grafly daemon stop`.

Optional deep/vision/naming/Brain operations use the model you configure and can
send repository material to it; a localhost proxy can forward to a cloud provider.
Deep can run through the current Codex or Claude terminal CLI with its existing
login, using Luna or Haiku. [Background Deep](docs/AUTO_DEEP.md) is opt-in and
consumes the user's model allowance; it needs no Grafly server or SSH tunnel.
Remote XERJ is also explicit. Telemetry is disabled without an explicit key.
See [security](SECURITY.md), [contributing](CONTRIBUTING.md), and
[release preparation](docs/OPEN_SOURCE.md).

## Canonical names

- CLI: `grafly`
- local graph/cache directory: `<repo>/.grafly/`
- environment variables: `GRAFLY_*`

The `grafly` CLI is installed, plus a `graft` alias to the same binary for
compatibility. Selected `GRAFT_*` environment
variables are recognized only so existing repositories can be migrated safely;
new configuration is written with Grafly names only.

## Migrating an existing Graft repository

After installing this version of Grafly, run this once from the old repository:

```bash
grafly migrate
```

That command removes legacy Graft wiring/cache (including old MCP
registrations), rewires detected agents, and rebuilds the graph into
`.grafly/`. Use `grafly migrate --dry-run` to preview, `--no-global` to leave
machine-wide agent settings untouched, or `--no-build` to skip the final build.

## Search and language coverage

Workspace searches accept `grafly grep <pattern> --in repo/src`, including Windows
path separators. The scope selects one child repository and its path prefix.
Structural questions such as `grafly ask "who calls targetTask"` also search
workspace children. `grafly callers targetTask --json` returns a `repos` array;
each section names its `repo` and keeps symbol IDs and paths relative to that child.
The same direction, depth and per-match `--limit` options apply to workspace callers.
Grep skips indexed paths that resolve outside the repository and reports them in
`truncated.files`.

`grafly build --extensions .go .py` limits structural indexing as well as the deep
pass. The graph records the selection for `check`, automatic refresh and background
sync, including workspace children. A later explicit build without the flag indexes
all supported extensions again.

When a native grammar cannot load, Grafly reports it and uses basic WASM extraction.
This has less precise bindings and call resolution. After repairing the native
installation, restart any resident `grafly serve` process and rebuild; cached WASM
results are replaced. Parser failures retain successful files but make the build
exit 1, including workspace builds. `--allow-partial` only relaxes deep-pass errors.

PowerShell `.ps1` and `.psm1` files support function definitions and command calls
through the breadth extractor. Python calls such as `import util as u; u.work()`
resolve inside the imported module, with lexical shadowing and ambiguity checks.
The new Python module-call handling covers direct `import` bindings; `from` imports,
re-exports and dynamic imports retain their previous behavior. Run `grafly build`
in an existing indexed repository to refresh extraction after upgrading.
Calls through unsupported export aliases or re-export chains remain unresolved
rather than matching unrelated global names. Overloads that cannot be separated
by argument count remain ambiguous.

## Resident CLI with embedded XERJ

Grafly embeds the real [XERJ](https://github.com/xerj-org/xerj) `xerj-fts` library,
pinned to rc.95, as a Node-API module. `grafly serve` keeps the CLI and FTS core
in **one local process**: no separate XERJ executable, HTTP listener or SSH tunnel.
Graphs, native FTS readers and concept cards stay loaded; disk/source changes
invalidate caches. This embeds the code-search core, not XERJ's unrelated server,
vector, memory or log-analytics features. Apache license/notice copies are under
`THIRD_PARTY_NOTICES/`.

Build the native module once with `npm run build:xerj` (Rust and a platform C
linker are required), then use `grafly daemon start`, `status`, `stop` or `restart`.
Stop before rebuilding the native module, then restart after updating Grafly.
The service closes a repository's index after five idle minutes, so on Windows the
repository can be moved or deleted again; rebuild the module once to get this.
The Windows installer builds
a missing module automatically.

`grafly serve --stdio` keeps stdin/stdout open for repeated JSON-line requests.
It emits a JSON `ready` record, then one response per request, preserving `id`:

```json
{"id":1,"command":"ask","query":"cache invalidation","cwd":"/path/to/repo","opts":{"source":true,"json":true}}
{"id":2,"command":"grep","query":"invalidate","cwd":"/path/to/repo","opts":{"fixed":true}}
{"id":3,"command":"build","argv":["build","."],"cwd":"/path/to/repo"}
{"id":4,"command":"callers","argv":["callers","invalidate","--json"],"cwd":"/path/to/repo"}
{"id":5,"action":"status"}
{"id":6,"action":"stop"}
```

Search responses contain `stdout`, `stderr` and `exitCode`. Requests run in order;
bad JSON produces an error response without terminating the CLI. EOF drains queued
requests and exits. Use one owner per machine; stop a background instance before
opening a stdio session. A persistent caller avoids launching Node per query.

`build` and `callers` reuse the existing CLI actions and options inside the same
process; `argv` includes the command and its flags. Builds and queries run in one
queue, so a query after a build sees the completed graph. A command error ends
that request, while the CLI stays alive. IPC status remains available during
asynchronous work and reports `activeCommand`. Accepted requests wait for completion
without a 30-second build deadline. An interrupted build reply returns an error
and never automatically launches a duplicate build; inspect status before retrying.

Existing shell commands and prompt hooks remain compatible: `ask`, `grep`, `build`
and `callers` send
requests to this resident CLI over authenticated local IPC. Their small shell
clients still exit after delivery; other commands use the regular CLI. A stopped
service falls back before delivery to regular execution; `GRAFLY_NO_DAEMON=1`
bypasses IPC. Older services advertise their supported commands, so updating the
package cannot accidentally send a build to an incompatible worker.

`--no-refresh` only skips the freshness check; `ask` can still sync XERJ and write
the answer cache. For investigations that must leave `.grafly/` untouched, pass
`--read-only` to any command, before or after it (`grafly --read-only callers x`), or set
`GRAFLY_READONLY=1` (forwarded to the resident service): no refresh, no XERJ sync and no answer-cache write. It is not offline: a
configured remote XERJ endpoint still receives the query, so add `--no-xerj` when the
question must stay local. A resident service that predates `--read-only` is bypassed.
Commands whose purpose is a write (`build`, `deepidx`, `init`, `hooks`, `brain note`, …)
refuse under it with a non-zero exit; `migrate-index` only plans, as with `--dry-run`.

On Windows, `scripts/install-search-service.ps1` installs the hidden
`Grafly-Search` logon task, with automatic recovery after a crash. It requires
Node and `pythonw`; explicit `-NodePath`/`-PythonwPath` select those executables.
Logs live under `~/.grafly/search-service/`. IPC uses an authenticated local
named pipe (Unix socket on other platforms); it opens no network search port.

The installer defaults to embedded XERJ and backs up the previous configuration.
An existing Oracle configuration is migrated by rerunning it without `-OracleHost`.
A first `ask` builds each indexed repository's local FTS projection automatically;
an explicit per-repo `xerj disconnect` remains an opt-out. Horang and Brain remain
independent. Existing external XERJ deployments may still select their own SSH
host with `-OracleHost <host>`; server deployment is managed separately.

## XERJ code-search backend

Grafly uses embedded XERJ to find code candidates, then applies its own graph
ranking, exact-symbol handling and source
excerpts. Structural queries such as callers stay in Grafly. Repository documents,
PDF pages and images share `ask` retrieval and source-backed code mentions;
Horang remains independent for long-term knowledge-base retrieval.

## Documents, PDFs and images

`grafly build` also indexes Markdown/text documents and PDF text locally, without
an embedding model. `grafly ask "fulfillment policy" --source` returns document
excerpts or PDF page pointers alongside code. Exact symbol/file mentions link
materials to the code and appear as backlinks on code hits.

Images are indexed by filename until you explicitly run `grafly build --vision`.
That pass reads images and image-only PDF pages with your configured vision-capable
model; it can send their contents to that provider. Successful extractions are
cached by source hash and reused by later offline builds. `--deep` remains the
separate code/concept summarization pass.

See [materials and provenance](docs/MATERIALS.md) for supported formats, limits,
failure handling and configuration.

The resident CLI connects repositories automatically. To opt in explicitly:

```bash
grafly build
grafly xerj connect embedded
grafly ask "where is cache invalidation handled?" --source
grafly xerj status
```

Embedded search calls native functions directly and keeps all token bags local.
For an explicitly selected legacy server, `xerj connect http://127.0.0.1:9200`
still accepts only loopback HTTP(S); set `GRAFLY_XERJ_API_KEY` for authentication.
Credentials are never persisted. `xerj connect` downloads no binaries, changes
no agent hooks and calls no LLM. The legacy wire contract was exercised against
XERJ 1.0.0-rc.95.

Every graph node's complete searchable token bags are mirrored; retrieval uses
a bounded top-candidate window, expands selected files to their graph spans, and
retains explicitly named definitions. The graph and lexical sidecar identify a
checkout-specific content generation. Builds sync a connected backend; stale,
unavailable or empty results fall back to builtin retrieval. `--in` filters the
backend request before ranking. JSON reports `searchBackend` (or per-child
`searchBackends` in workspaces); text reports backend/fallback on single-repo asks.

Use `grafly xerj sync` to repair/retry, `grafly ask ... --no-xerj` to compare with
builtin retrieval, or `grafly xerj disconnect` to return to builtin retrieval.
Workspace parents federate configured child backends and builtin children;
connect at each child. `new Grafly().askAsync(...)` supports the backend in
long-lived integrations; synchronous `ask(...)` retains its builtin contract.

XERJ state is local under `.grafly/.cache/xerj.json`. Interrupted sync never
publishes a partial generation. Embedded FTS files live under `.grafly/.cache/xerj/`;
the manifest is published only after a complete index opens successfully and the
source generation is rechecked. Successful sync retains the current and previous
embedded generations and prunes older owned files under a shared cache lock.
Live reader snapshots remain usable; locked files are retried on the next sync.
Unknown files and linked directories are preserved. Disconnect preserves derived data.
Whole bodies are indexed,
while source excerpts and result counts remain bounded independently.

## Judgment circuit

`dist/circuit/judge.js` ranks ambiguous same-name symbols using typed features
and a linear score. A `confident` verdict means only that the top-two score gap
cleared the configured threshold; it is not a measured probability of correctness.

The bundled weights are seed weights. Replace them only with an artifact calibrated
for Grafly's same-name-disambiguation task.

- `GRAFLY_WEIGHTS=/path/to/weights.json`
- `GRAFLY_ABSTAIN=<positive number>`
- `GRAFLY_CIRCUIT_LOG=0` disables local judgment logging.

`callers` prints a judgment ID; `--json` also exposes exact candidate IDs.
Record a checked answer with `grafly feedback <jid> <candidate-id|abstain>
--evidence "what was verified"`. Reviews remain local. With MC local learning
explicitly enabled, they also enter the verified runtime's feedback inbox;
model activation requires its development and fresh audit gates to pass.
See [explicit reviews and log reasons](docs/MC_FEEDBACK.md).

To enable MC source-evidence analysis, run `grafly mc-analyzer configure --home
<trusted-mc-installation> --python <absolute-executable>`. `grafly callers` then
hands ambiguous dropped call sites to MC's `code_relation` channel; `grafly
mc-analyzer judge` queries it directly. See [installed analyzer and host routing](docs/MC_HOST_ROUTING.md)
for scope, configuration, verification and distribution limits.

## Local brain

Brain stores and mines repository rules on the user's machine. No Brain account,
server, token or GitHub origin is required. Build the graph, then opt in:

```sh
grafly build
grafly brain enable        # migrate cached rules and start background mining
grafly brain status        # worker state, errors and rule counts
grafly brain mine          # run a pass now, in the foreground
grafly brain disable       # stop automatic mining; keep all saved rules
```

Enabled repositories schedule a hidden worker during CLI/search usage, at most
once every six hours. A process lock prevents overlapping mining; unchanged
digests skip the model call. There is no listening server or system service.
State and the latest worker log live in `.grafly/.cache/brain-worker.json` and
`brain-worker.log`. Existing notes survive failed or concurrent mining, and
disabling mining prevents an in-flight result from being applied.

Mining uses Grafly's configured provider (`GRAFLY_PROVIDER`, `GRAFLY_API_KEY`,
`GRAFLY_MODEL`, `GRAFLY_BASE_URL`) or a keyless endpoint at
`GRAFLY_AMBIENT_URL` (default `http://127.0.0.1:10531/v1`). A local endpoint can
also be set with `GRAFLY_BASE_URL`. The digest contains commit messages, docs,
configuration and symbol metadata: **a remote model receives that digest and
may charge for usage**. Missing model configuration is reported as `needs-model`;
existing rules continue to work. Digests do not fetch GitHub discussions.

`brain enable` converts a stored remote connection locally while preserving its
cached rules; old Brain environment credentials cannot override the local mode.
`connect`, `push` and `pull` are retired. `grafly init --brain local` can enable
mining during setup. `GRAFLY_NO_BRAIN=1` suppresses automatic mining, and read-only
queries never schedule it. The retired HTTP/storage implementation and its tests
are maintained separately; this tree ships only the shared mining module.

No model is required for `grafly brain note`: it records known rules locally,
anchored to a graph symbol or marked `--repo-wide`. `grafly brain digest` prints
the local digest for an agent to review and use with `brain note --file`.

## Morecoffee boundary

Training, evaluation and threshold calibration are implemented in Morecoffee.
Grafly consumes verified channels and approved model artifacts, and can export
local observations and explicit reviews to the managed MC runtime's learner.
See [managed runtime and local learning](docs/MC_RUNTIME.md) for opt-in controls
and activation gates.

## Telemetry

Telemetry is disabled by default. There is no baked ingestion
key and the postinstall hook sends nothing. An explicit `GRAFLY_POSTHOG_KEY`
(or legacy `GRAFT_POSTHOG_KEY`) is required before network telemetry can run.

See [TELEMETRY.md](./TELEMETRY.md).

## Agent hooks

Installing the package does not change agent settings. Explicit `grafly init`
or `grafly hooks` opts in to integration. Existing hooks are preserved. `grafly hooks`
reconciles that wiring with the installed defaults — a drifted entry or shim is
rewritten, a missing one added; `--dry-run` reports without writing.
Codex uses `CODEX_HOME` when set, otherwise `~/.codex`. Installation and removal
preserve other tools' handlers, including handlers sharing a Grafly hook group.
Claude initialization refuses malformed settings without overwriting them. Claude
hook timeouts are in seconds; re-run `grafly init --agents claude` to refresh old
entries. The retraction API previews changes unless `apply: true` is explicit.
Copied shims retain their installing package path, so local installs work without
a global Grafly package. Reinstall or run `grafly hooks` after moving that package.

## Hermes automatic retrieval

An opt-in native `pre_llm_call` shell hook supplies ranked pointers from existing
local indexes, once per user turn. It composes with existing Hermes hooks and
does not rebuild, update, upload to Brain, or rewire another host.
See [setup, protocol, and safety bounds](docs/HERMES_HOOK.md).

## Development

Grafly requires Node >=22.12.0.

```bash
npm ci
npm test
```

`dist/*.js` is the product source; there is no TypeScript build step. Maintain
the shipped `.d.ts` declarations alongside JavaScript changes. The declaration
contract test checks exported names and literal constants. Legacy source maps
are excluded from npm packages because their original TypeScript sources are absent.

The test runner isolates inherited `GRAFLY_*` and legacy `GRAFT_*` settings so
user configuration cannot disable features under test. It retains the explicit
`GRAFLY_TEST_CODEX`, `GRAFLY_TEST_PYTHON` and `GRAFLY_TEST_MC_SOURCE` runtime opt-ins.
MC environment overrides are isolated too; observations go to a temporary disabled
learning home. Individual fixtures set their own configuration after isolation;
user environment settings are unchanged.

See the [documentation index](docs/README.md) for guides, historical evaluations,
retired features, and dependency checks.
It also lists the maintained offline analysis tools and retired development scripts.

## Command output

`grafly run -- python -m unittest -v tests.test_example` runs once, keeps raw
stdout/stderr, and applies MoreCoffee's deterministic `tool_output` channel
before returning recognized passing test output. `grafly output <id>` retrieves
verified originals. `grafly output-hook` adds Codex/Orca routing guidance while
retaining normal tool permissions. [Setup and limits](docs/TOOL_OUTPUT.md).
