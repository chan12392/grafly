<!-- grafly:brain:start -->
## House rules for this codebase

Mined from grafly's own history — commit messages and pull-request
discussion. These are decisions the team has already made, so
follow them and do not re-litigate them in passing. Each is attributed to
what established it.

### dist/ai/providers.js
- Treat Grafly as the canonical identity while retaining legacy Graft names only for migration compatibility. (https://github.com/chan12392/grafly/commit/aa74366461)
- Keep registry update checks and upgrade behavior disabled unless GRAFLY_NPM_PACKAGE is explicitly configured. (https://github.com/chan12392/grafly/commit/aa74366461)

### dist/app/history.js
- Mine repository decisions from the digest and anchor each accepted rule to exactly one graph symbol or explicitly mark it repo-wide.

### dist/brain/note.js
- Allow brain notes to be recorded locally without a server or LLM key, while posting linked-repository notes best-effort.

### dist/circuit/feedback.js
- Record only the first adopt or reject follow-up within the two-hour judgment window and rotate the feedback log near 1.5 MB. (https://github.com/chan12392/grafly/commit/5d8ae982ad)

### dist/circuit/judge.js
- Use the judgment circuit to disambiguate same-name symbols and abstain when the score gap is insufficient. (https://github.com/chan12392/grafly/commit/e64479c310)
- Load circuit weights from a JSON artifact and permit an explicit GRAFLY_WEIGHTS override instead of hardcoding retrained weights in JavaScript. (https://github.com/chan12392/grafly/commit/cf1d1f68a3)
- Rank ambiguous symbols using working-directory affinity and a mild test-path penalty so production definitions win ties. (https://github.com/chan12392/grafly/commit/ab59ae4094)
- Expose explainable verdict reasons that distinguish feature separation, ties, weak gaps, and entirely vendored candidate pools. (https://github.com/chan12392/grafly/commit/2081e54952)
- Run the same circuit, ranking, verdict, and shared-adjacency behavior across CLI, MCP, and workspace callers surfaces. (https://github.com/chan12392/grafly/commit/5d8ae982ad)

### dist/graph/build.js
- Treat dist/*.js as the product source and edit it directly because this repository has no src tree or build step.

### dist/graph/enrich.js
- Create deterministic crux entries for trivial nodes, exclude them from LLM enrichment, and skip file description when every node is trivial. (https://github.com/chan12392/grafly/commit/6bb830c654)

### dist/graph/traverse-cli.js
- Write judgment verdicts, score gaps, features, and reasons as JSONL beside the graph unless GRAFLY_CIRCUIT_LOG disables or redirects logging. (https://github.com/chan12392/grafly/commit/f00377985d)
- Build shared adjacency once per command and apply judgment and --top truncation before walking edges. (https://github.com/chan12392/grafly/commit/c0ee5f84df)

### dist/telemetry/gate.js
- Keep telemetry disabled unless GRAFLY_POSTHOG_KEY is explicitly configured. (https://github.com/chan12392/grafly/commit/66a4aefc58)
<!-- grafly:brain:end -->
