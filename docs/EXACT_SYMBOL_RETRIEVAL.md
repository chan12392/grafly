# Exact identifier retrieval

Branch: `test/prompt-retrieval-gate`, following prompt-gate commit `857871e`.
This experiment changes Grafly's local retrieval engine. MoreCoffee's channel
implementation and the installed global package/hook are unchanged.

## Problem and change

`Where does writeSession persist the session cache?` located the definition in
the Grafly project, but generic session/cache results from other projects filled
the three slots in the home hook. Subword matching split the name into `write`
and `session`; cross-project reciprocal-rank fusion then lost the distinction
between an exact definition and a partial term match.

Explicit code identifiers now supply a separate ranking signal:

- Recognize camel case, snake case, qualified names, constants, dollar names,
  quoted identifiers, call syntax and a bare identifier query.
- Match case-sensitive definition names from the existing graph, including a
  qualified definition's leaf when the request is unqualified. Exclude file
  nodes, body-only references and longer names sharing a prefix.
- Put exact definitions before the existing lexical/file selection, before
  output truncation. Preserve source pointers, scope filtering, deterministic
  ordering, duplicate removal and existing test-file preference.
- Carry `AskHit.exactSymbol` through workspace federation. Explicit definitions
  survive coverage gates and rank fusion without comparing raw lexical scores
  from different repositories.
- Let the prompt formatter retain exact definitions in long, otherwise weak
  queries. Session novelty filtering still prevents duplicate injection.

The shared tokenizer, sidecar format, subword scores and RRF algorithm are
unchanged; no index rebuild is required. Structural queries with indexed edges
still return callers/callees. Unresolved structural requests retain their
existing fallback note and use the improved lexical fallback.

Result array order is authoritative, as it already was for file selection.
Exact hits retain available local lexical scores (zero if no lexical candidate
survived); ordinary workspace hits retain RRF scores. Consumers must not sort
these evidence classes together by their numeric scores.

## Verification

- Full suite: 73 tests passed, including 19 new retrieval regressions.
- Synthetic fixtures exercise truncation, 10-project competition, cached and
  uncached indexes, both workspace file-selection modes, multiple scopes,
  source inlining, same-file spans, punctuation, stopwords/one-letter names,
  false prefix/case matches, callers and per-session novelty.
- Paired live-index replay: 13 definitions across Grafly, Freeable, MMM backend
  and MoreCoffee, each with an English question and a Korean request. All ten
  existing home indexes participate. Expected definitions are checked against
  their current source spans before comparison.
- The 26 exact-name questions improved from 17/26 to 26/26 in the home's top
  three; all 26 candidate results ranked the expected definition first. The
  formatter included the expected pointer for every case. Project-local top
  three coverage stayed 26/26.
- The original `writeSession` question moved from workspace rank 11 to rank 1
  (and project-local rank 2 to rank 1).
- 24 controls (16 natural-language and eight structural, missing-name or path
  queries) returned byte-identical result objects before and after.
- Existing graph/sidecar files, workspace manifest and installed home hook are
  hashed before and after replay. The final replay also hashes both engines.
- Direct branch-hook subprocess smoke: a fresh isolated session received the
  `writeSession` pointer; repeating the same query emitted no duplicate context.
  Its generated session file was removed afterward. Installed engine files also
  matched the pre-change snapshot after normalizing CRLF/LF line endings.
- Final warm-process timing median: 1,078.75 ms before, 1,174.79 ms after, over
  12 alternating pairs. The first replay had 1,026.94 / 986.29 ms, so these small
  samples do not establish a speed improvement. The final sample was about 9%
  slower; the demonstrated improvement is exact-name retrieval quality.

This is a targeted regression evaluation, not a general search-quality claim.
Same-name definitions can remain ambiguous; unknown or differently cased names
retain ordinary search behavior. Direct branch-hook execution does not
constitute installation or a fresh Codex/Orca host-session deployment test.

## Reproduce

Run `npm test` for the portable regression suite. The saved-index evaluation
requires a pre-change package copy and an indexed home with the listed projects:

```powershell
node scripts/evaluate-exact-symbol.mjs `
  C:/Users/example/Backups/Grafly-exact-symbol-20260920/baseline `
  C:/Users/example `
  C:/Users/example/Backups/Grafly-exact-symbol-20260920/replay-final.json
```

Artifacts live in `C:/Users/example/Backups/Grafly-exact-symbol-20260920/`:
`baseline/`, `replay.json` (first pass), `replay-final.json` (final code),
`hook-smoke.json`, `installed-comparison.json`, and
`validation/validation-reports/` with linked complete stdout/stderr artifacts.
Timing uses 12 alternating warm-process pairs and excludes process startup;
it is a latency sanity check, not an end-to-end hook speedup claim.
