# Project materials

Grafly keeps current project documents and code references in the same local
retrieval workflow. No embedding model, vector database or Horang service is
required.

```sh
grafly build
grafly ask "fulfillment policy" --in docs --source
grafly ask "shipOrder" --source
```

The default build reads `.md`, `.mdx`, `.txt`, `.rst` and PDF text locally.
PNG, JPEG, WebP and GIF filenames are searchable immediately. Source text is
split into bounded excerpts; PDF excerpts carry page numbers. JSON results carry
`material` provenance (original path, content hash, extraction method and status)
and `references` (code pointer, exact evidence and confidence).

Exact file paths and unambiguous code identifiers create `mentions` links.
An ambiguous name is linked only when a mentioned source path identifies one
candidate. These links are separate from the AST's calls/imports. Code hits
return document backlinks in `related`; the Context visualization includes
materials and their referenced code. Verify source before editing or treating a
mention as evidence of behavior.

## Images and scanned pages

```sh
grafly --provider openai --model <vision-model> --base-url <endpoint> build --vision
```

Use the existing `GRAFLY_API_KEY`, `GRAFLY_PROVIDER`, `GRAFLY_MODEL` and
`GRAFLY_BASE_URL` configuration, or a reachable keyless local endpoint.
The selected model must accept images. `--vision` is explicit because it may
send image contents to that provider and incur its normal usage cost. It does
not change the configured model. `--deep` summarizes code/concepts and does not
implicitly enable vision.

For plain vision requests, a proxy's explicit rejection of Chat Completions data
URLs triggers one equivalent request through its Responses endpoint, using the
same model and credentials. Other errors and tool conversations retain their
normal failure behavior.

The pass extracts visible text and a short description from images and PDF
pages with no text layer. Model-derived identifiers are marked `vision` in the
reference confidence. Each successful extraction is cached by original bytes
and model label; later default builds/automatic refreshes reuse it offline.
Changed bytes invalidate old extractions. Missing text layers remain
`pending`/`partial` until vision is requested. Pages with an existing text layer
use that layer; embedded diagrams on those pages are not separately interpreted.

## Scope, freshness and failures

Materials use the same Git ignore, dependency-directory, symlink, submodule,
nested-repository and `--only-dir` boundaries as code. `--extensions` restricts
code parsers; it does not remove project materials. Code files retain the 1 MB
limit; supported materials allow up to 20 MB per file. Larger files are excluded
by the walker. PDF extraction reads at most 200 pages and 2 million characters;
the material status is `partial` when those extraction limits are reached.
Rendered pages are capped at 2000 pixels on the longer side. Optional
`@napi-rs/canvas` supplies local rendering for scanned PDF pages; without a
working renderer these pages report extraction errors, while PDF text and
ordinary image requests still work.

`.grafly/.graph/materials.json` stores extracted text, source hashes, statuses
and reference evidence. It is a local regenerable cache and can contain private
document text; keep `.grafly/` ignored. Material-only edits, additions and
deletions participate in the existing freshness gate. `--no-refresh` deliberately
uses saved evidence. Rebuilds relink cached text against the current code graph,
so deleted/renamed definitions do not retain stale links.

Extraction errors retain the healthy code graph and useful evidence for unchanged
source bytes, but an explicit build exits 1. `--allow-partial` accepts that
degraded result. Unreadable/changed files never reuse text from different bytes.
Failed extractions are retried on later builds. `grafly grep` and `callers` retain
their code-only contracts; use `ask` for mixed material/code retrieval.

Horang remains a separate long-term knowledge service. This change does not
copy or delete its knowledge, provision an embedding model or export project
materials to it.
