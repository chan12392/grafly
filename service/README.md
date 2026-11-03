# Shared local Brain miner

`brain-mining.mjs` validates model output and anchors rules to digest symbols.
It is used by `dist/brain/local.js` through Grafly's configured ChatModel.

Use `grafly brain enable`, `grafly brain mine` and `grafly brain status`.
The retired HTTP server, storage, deployment scripts and their contract tests
are maintained separately. This directory does not run a network service.
