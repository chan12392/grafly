# Documentation

## Usage and integration

- [Command output, archives and bounded reads](TOOL_OUTPUT.md)
- [MC runtime](MC_RUNTIME.md)
- [Installed host routing and acceptance evidence](MC_HOST_ROUTING.md)
- [Hermes hook setup](HERMES_HOOK.md)
- [Automatic deep indexing](AUTO_DEEP.md)
- [Exact-symbol retrieval](EXACT_SYMBOL_RETRIEVAL.md)
- [Documents, PDFs, images and code references](MATERIALS.md)

## Historical evaluations

These documents record results at their stated revisions and dates.

- [Deep indexing and MC review](DEEPIDX_MC_REVIEW.md)
- [Hermes hook validation](HERMES_HOOK_VALIDATION.md)
- [MC accuracy evaluation, 2026-09-21](MC_ACCURACY_EVAL_20260921.md)
- [Initial prompt retrieval gate experiment](PROMPT_RETRIEVAL_GATE.md)
- [Expanded prompt retrieval gate evaluation](PROMPT_RETRIEVAL_GATE_V2.md)
- [Tool output validation, 2026-09-22](TOOL_OUTPUT_VALIDATION_20260922.md)

The expanded prompt-gate evaluation supersedes the initial measurements; both
remain available for provenance.

## Retired features

- [Session compaction retirement](SESSION_COMPACT.md)
- [Live session compaction retirement](LIVE_SESSION_COMPACT.md)

The session compaction implementations are no longer shipped. These notices
preserve the retirement context and point to command output handling.

The GitHub App webhook server (`dist/app/main.js` and its review/page/queue
modules) was removed: nothing in this checkout deployed or invoked it. The
local brain path (`grafly brain mine`) keeps the digest readers in
`dist/app/history.js` and `dist/app/sources.js`.

## Dependency and release checks

Run `npm ci` and `npm audit` against the lockfile, not just an existing
`node_modules` directory. The Node-gyp dependency now locks Undici 6.29.1,
which includes the [upstream security fixes](https://github.com/nodejs/undici/security/advisories/GHSA-2m5v-pch6-74hx).
Do not apply major-version overrides or `npm audit fix --force` without testing.
See [release preparation](OPEN_SOURCE.md) for package and disclosure boundaries.

Historical validation reports contain machine-private evidence, not downloadable
fixtures. `C:/Users/example` paths are redacted examples. Reproduce supported
behavior with the checked-in tests; those reports do not prove a new release.

## Development utilities

These scripts are manual tools, so they need no import from the runtime:

- `node scripts/circuit-log-analyze.mjs --dir <repo> [--query X]` summarizes
  local circuit verdicts and feedback; explicit JSONL paths are also accepted.
- `node scripts/tally-audit.mjs <transcript-dir> [--json]` audits local Claude
  transcripts for reported token savings. It recognizes Grafly and legacy Graft
  footers; the JSON field `graft_turns` is retained for compatibility.

The browser viewer, bundled D3 and obsolete viewer build recipe have been removed.
`grafly viz` (including `--export`) and `blast --export-viz` are no longer available.
`blast` still supports text, JSON, Markdown and Mermaid reports without D3.

`scripts/hermes-route.py` is a legacy standalone adapter. Current installations
use `scripts/hermes-grafly/`. The legacy file remains in the repository for
provenance and is excluded from npm packages.
