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
local brain path (`grafly brain push`) keeps the digest readers in
`dist/app/history.js` and `dist/app/sources.js`.

## Outstanding dependency advisory

`npm audit` currently reports four moderate entries along the single
`gray-matter → js-yaml → argparse → sprintf-js` chain. The underlying
[sprintf-js advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)
lists no patched version. Grafly uses gray-matter for local frontmatter handling.

Do not use `npm audit fix --force`: the reported fix downgrades gray-matter to
2.0.1 across a major-version boundary. A major override of js-yaml/argparse also
changes their APIs and needs separate compatibility work. Retain the current
dependency until a compatible fix or a verified parser migration is available;
the warning is not suppressed.

## Development utilities

These scripts are manual tools, so they need no import from the runtime:

- `node scripts/circuit-log-analyze.mjs --dir <repo> [--query X]` summarizes
  local circuit verdicts and feedback; explicit JSONL paths are also accepted.
- `node scripts/tally-audit.mjs <transcript-dir> [--json]` audits local Claude
  transcripts for reported token savings. It recognizes Grafly and legacy Graft
  footers; the JSON field `graft_turns` is retained for compatibility.

`scripts/build-viewer.mjs` is an obsolete build recipe whose original
`viewer/` and `src/` inputs are absent. Grafly ships `dist/viewer/` directly;
there is no viewer rebuild step. The recipe now exits before writing anything
when those inputs are missing. The direct `esbuild`, `d3-force` and
`@types/d3-force` development dependencies are no longer needed. `tsx` still
uses esbuild transitively for the test runner's TypeScript support.

`scripts/hermes-route.py` is a legacy standalone adapter. Current installations
use `scripts/hermes-grafly/`. Both legacy files remain in the repository for
provenance and are excluded from npm packages.
