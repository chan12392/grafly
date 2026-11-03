<!-- grafly:brain:start -->
## House rules for this codebase

Mined from grafly's own history — commit messages and pull-request
discussion. These are decisions the team has already made, so
follow them and do not re-litigate them in passing. Each is attributed to
what established it.

### dist/ai/providers.js
- Treat Grafly as the canonical identity while retaining legacy Graft names only for migration compatibility. (https://github.com/chan12392/grafly/commit/5d60c8a3eca7eaddb36fe3ef8ec3fe0e06201e5b)
- Keep registry update checks and upgrade behavior disabled unless GRAFLY_NPM_PACKAGE is explicitly configured. (https://github.com/chan12392/grafly/commit/5d60c8a3eca7eaddb36fe3ef8ec3fe0e06201e5b)
- Allow keyless deep indexing through the ambient local endpoint when no API key is configured. (https://github.com/chan12392/grafly/commit/a2221ae6d918e1ce983608a1f1aa8ad668327516)
- Treat GRAFLY_* environment variables as primary while retaining legacy graft variables for migration compatibility. (https://github.com/chan12392/grafly/commit/04dc060163a5839be0fe3133af23d0d79435a2e5)

### dist/app/history.js
- Mine repository decisions from the digest and anchor each accepted rule to exactly one graph symbol or explicitly mark it repo-wide.

### dist/ask/ask.js
- Keep exact symbol matches prioritized across workspace retrieval. (https://github.com/chan12392/grafly/commit/8f0ad605b5fa98d72b4efc811e555124b1aee3fa)

### dist/brain/note.js
- Allow brain notes to be recorded locally without a server or LLM key, while posting linked-repository notes best-effort.
- Local brain notes and digests must work without a server or LLM key, with pushes to a linked brain best-effort. (https://github.com/chan12392/grafly/commit/a2221ae6d918e1ce983608a1f1aa8ad668327516)

### dist/circuit/escalate.js
- Keep MoreCoffee escalation of ambiguous call sites opt-in, bounded, and nonfatal. (https://github.com/chan12392/grafly/commit/66bee2e943b22eca2f823757a5a9de48cc93251e)

### dist/circuit/feedback.js
- Record only the first adopt or reject follow-up within the two-hour judgment window and rotate the feedback log near 1.5 MB. (https://github.com/chan12392/grafly/commit/b25457905e1e90c167bf6b144289a0241e3f888e)

### dist/circuit/judge.js
- Use the judgment circuit to disambiguate same-name symbols and abstain when the score gap is insufficient. (https://github.com/chan12392/grafly/commit/3f254416834cc5dbf09c480d544a2bc4ac1de4d3)
- Load circuit weights from a JSON artifact and permit an explicit GRAFLY_WEIGHTS override instead of hardcoding retrained weights in JavaScript. (https://github.com/chan12392/grafly/commit/c3b45f0994f370105b91aae6903991acafc9e305)
- Rank ambiguous symbols using working-directory affinity and a mild test-path penalty so production definitions win ties. (https://github.com/chan12392/grafly/commit/72e3ec92bcceb6e05be444e3e666e74c56c5358c)
- Expose explainable verdict reasons that distinguish feature separation, ties, weak gaps, and entirely vendored candidate pools. (https://github.com/chan12392/grafly/commit/4f3aad935b6316b2c1d54678f22b2e25b5db06b4)
- Run the same circuit, ranking, verdict, and shared-adjacency behavior across CLI, MCP, and workspace callers surfaces. (https://github.com/chan12392/grafly/commit/b25457905e1e90c167bf6b144289a0241e3f888e)
- Favor production definitions over otherwise comparable test helpers without excluding test-only matches, and account for the caller's working directory. (https://github.com/chan12392/grafly/commit/72e3ec92bcceb6e05be444e3e666e74c56c5358c)
- Penalize vendored candidates rather than letting graph degree alone favor library code. (https://github.com/chan12392/grafly/commit/a2dd4b7190c3c1934db6035f8fe6dfa4f518eb86)

### dist/claude/prompt-gate.js
- Skip recognizable conversation without suppressing retrieval for short or mixed task prompts. (https://github.com/chan12392/grafly/commit/381342f7e86a0203b2cafde4e4bd95be65a934c9)

### dist/cli.js
- Treat grafly as the canonical CLI identity and retain graft only as a compatibility alias, not an upstream benchmark. (https://github.com/chan12392/grafly/commit/b75f3e06716a45b997d34ddc53ec1b37cbe46805)

### dist/graph/build.js
- Treat dist/*.js as the product source and edit it directly because this repository has no src tree or build step.

### dist/graph/enrich.js
- Create deterministic crux entries for trivial nodes, exclude them from LLM enrichment, and skip file description when every node is trivial. (https://github.com/chan12392/grafly/commit/f28dba4170bc82978bfcb2cb586c336d01f0d88c)

### dist/graph/load.js
- Fall back to the full graph when the traversal sidecar is missing or older than wiring.json. (https://github.com/chan12392/grafly/commit/57b179c6b43f9ec8cb4fc601fe427c7c577cf4e2)

### dist/graph/resolve.js
- Resolve calls with import specifiers only through the specified module, leaving ambiguous targets unresolved rather than guessing. (https://github.com/chan12392/grafly/commit/81edd86f1803839da90159d4530e46a69f117ad9)
- Record ambiguous edge attribution so callers can report undercounts instead of silently hiding them. (https://github.com/chan12392/grafly/commit/b75f3e06716a45b997d34ddc53ec1b37cbe46805)

### dist/graph/traverse-cli.js
- Write judgment verdicts, score gaps, features, and reasons as JSONL beside the graph unless GRAFLY_CIRCUIT_LOG disables or redirects logging. (https://github.com/chan12392/grafly/commit/a2dd4b7190c3c1934db6035f8fe6dfa4f518eb86)
- Build shared adjacency once per command and apply judgment and --top truncation before walking edges. (https://github.com/chan12392/grafly/commit/3d820f59cc0cc36f57f4832385f28a3bf55da4aa)
- Never truncate ambiguous symbol candidates with --top when the circuit abstains. (https://github.com/chan12392/grafly/commit/51facff814a7b16e8d9aa7031657f585b2c1816e)
- Expose circuit ranking scores as learned ranking weights rather than probabilities, with null confidence and machine-readable limitations. (https://github.com/chan12392/grafly/commit/cf25d98d8eaed21e6f2bd309996784f4ab316c9c)
- Build walk adjacency once per callers command and judge candidates before walking edges to avoid per-match graph scans. (https://github.com/chan12392/grafly/commit/3d820f59cc0cc36f57f4832385f28a3bf55da4aa)
- Preserve all ambiguous symbol candidates when the circuit abstains, even if a top-match limit was requested. (https://github.com/chan12392/grafly/commit/51facff814a7b16e8d9aa7031657f585b2c1816e)

### dist/graph/workspace.js
- Apply the same ambiguous-symbol judgment and ranking behavior across CLI, MCP, and workspace callers surfaces. (https://github.com/chan12392/grafly/commit/b25457905e1e90c167bf6b144289a0241e3f888e)

### dist/hosts/devin-hooks.js
- Merge only Grafly-owned Devin hook entries and preserve external hooks. (https://github.com/chan12392/grafly/commit/67764b7aeefa57ee4828d0b14ede02137f40ff87)

### dist/telemetry/gate.js
- Keep telemetry disabled unless GRAFLY_POSTHOG_KEY is explicitly configured. (https://github.com/chan12392/grafly/commit/04dc060163a5839be0fe3133af23d0d79435a2e5)

### dist/tool-output/retention.js
- Cap raw-output archives at 20 MiB while protecting active writers from pruning. (https://github.com/chan12392/grafly/commit/680e5434b6c8431f99115971cf3e9cf5fdedccb1)

### dist/tool-output/runner.js
- Execute commands once and preserve raw stdout and stderr archives for integrity-checked retrieval while MoreCoffee owns output reduction decisions. (https://github.com/chan12392/grafly/commit/7741d8282fe3ce9f8e28a575d477cd32bae4f239)
- Keep unknown, side-effecting, and shell-wrapped commands raw rather than applying bounded output reduction. (https://github.com/chan12392/grafly/commit/1495c158e0fc04420fb663c83bc2cf07c7b9a81b)
- Preserve failure output rather than reducing it. (https://github.com/chan12392/grafly/commit/928d19ca4d904355f81acffd97455c2cef511584)
- Reject rewritten output with an invalid declared byte count and fall back to the raw stream. (https://github.com/chan12392/grafly/commit/55c83fa95bf885a11c200aecede0e01871f64fb4)
- When GRAFLY_TOOL_OUTPUT=0, stream output without creating archives, invoking MoreCoffee, or reducing output. (https://github.com/chan12392/grafly/commit/0c63692c48a11a2ce83460b316c70fe6e2db46e3)

### dist/util/state.js
- Use the hidden .grafly index layout while recognizing legacy directories that already contain an index. (https://github.com/chan12392/grafly/commit/0938e55d7ae5995ecceb2915cdb929eddb2768e1)

_16 more rules apply to specific symbols; grafly attaches those to each `grafly ask` answer._
<!-- grafly:brain:end -->
