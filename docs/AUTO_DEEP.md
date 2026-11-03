# Automatic deep indexing

Deep runs the active terminal agent in noninteractive mode: `codex exec` or
`claude -p`. The CLI handles its existing login; Grafly does not read or copy
credentials. Codex uses a visible Luna model from its local model catalog
(default `gpt-6-luna`) with low reasoning; Claude uses the `haiku` alias.
Unavailable models or authentication failures stop the pass without switching
agents, upgrading the model, or falling back to a proxy.

Workers and indexes are local. Model inference still goes to the CLI's provider,
sends the selected source excerpts, and consumes that user's plan/API allowance.
The foreground conversation, model selection, and session history are unchanged.
The subprocess has a temporary working directory, disables customizations and
command tools, and does not resume or persist an interactive conversation.
Codex also disables apps, plugins, image generation, and skill search.
This adapter targets the official Codex/Claude login paths; custom CLI providers
and vision should use Grafly's explicit API configuration instead.

## Opt in

Create `~/.grafly/auto-deep.json` with permitted Git project roots:

```json
{
  "enabled": true,
  "transport": "agent",
  "roots": ["/absolute/path/to/projects"]
}
```

On Windows, use paths such as `C:/Users/example/projects`. Configuration and the
queue are shared across hosts, independently of `CODEX_HOME`. Each queued job
records the triggering agent and its `CODEX_HOME` or `CLAUDE_CONFIG_DIR` path,
so a worker started by another session uses the correct profile. Credentials
are not stored in queue files. One worker runs one model request at a time.

The Codex and Claude hooks enqueue changed source during repository usage.
Only Git projects inside the allowed roots qualify; opening the home workspace
does not enqueue every child. Hooks return the saved index immediately while a
hidden worker handles Deep. Ordinary build, retrieval refresh and Stop sync
remain structural and offline.

Outside an active agent terminal, choose the CLI explicitly:

```sh
GRAFLY_AGENT_HOST=codex grafly deepidx . --background
# PowerShell: $env:GRAFLY_AGENT_HOST = 'codex'
grafly deepidx . --status
grafly deepidx .                    # run now using the same configuration
grafly build --deep                # explicit build; no automatic-queue opt-in needed
```

`GRAFLY_AGENT_HOST=claude` selects Claude. Other host adapters need this explicit
selection; Grafly does not guess between installed accounts. An explicit
`GRAFLY_API_KEY` retains the API route for `build --deep`. Brain mining and vision
keep their separately configured model paths.

## Completion and recovery

A structural index is written before requesting a model, so failed Deep still
leaves usable retrieval. State under `~/.grafly/auto-deep/` records the phase,
model and errors. `ready` requires successful concept generation and no pending,
stale or failed symbol summaries. A failed or partial pass does not count as
Deep completion, and prior successful concepts and summaries remain available.

Content-hash caches skip unchanged source. An unchanged completed map returns
without a model request. New sessions bypass the hourly activity cooldown;
duplicate callbacks coalesce. Sessions arriving during a build stay queued.
The project lock prevents concurrent index writes. A busy writer is retried;
the durable queue and five-minute stale-lock recovery survive worker crashes.
CLI requests time out after three minutes and clean up temporary output.

Set `enabled` to `false` to stop scheduling and further queued projects. The
current project finishes its pass. `GRAFLY_NO_AUTO_DEEP=1` disables automatic
Deep; `GRAFLY_NO_AUTO_INDEX=1` disables both kinds of automatic indexing.
`GRAFLY_READONLY=1` also prevents scheduling and draining queued Deep jobs.

Existing configurations with an explicit loopback `baseUrl` remain compatible.
To migrate, back up the configuration, set `transport` to `agent`, and remove
`baseUrl` and `model`. No model service or SSH tunnel is needed or started by
this path. Old queued jobs without an agent profile fail explicitly; a fresh
agent session queues a correctly scoped request.

Indexes live in `.grafly/`. `grafly migrate-index . --dry-run` previews legacy
migration; `grafly migrate-index .` verifies copies and archives originals.
Conflicting files and active writers stop migration without overwriting either
copy. Retired concept cards are archived in `.grafly/.cache/concept-history/`;
these index backups have no automatic expiry.
