# Contributing

Grafly's canonical repository is `chan12392/grafly`. Open issues and pull requests
here. Do not submit Grafly changes to Graft or add an upstream synchronization
remote; Grafly has an independent roadmap.

Use Node >=22.12.0, run `npm ci`, then `npm test`. Windows and Linux with Node 22
and 24 are the CI targets. Rust and a platform C linker are optional for
`npm run build:xerj`; ordinary graph/search tests do not require a Brain server,
model key or MoreCoffee installation.

`dist/*.js` is source, not generated output. There is no `src/` build step. Update
matching `.d.ts` declarations when changing interfaces. Keep fixes focused, add a
regression test for changed behavior, and describe the problem, result and checks
in the pull request. Preserve unknown/ambiguous relationships rather than inventing
call edges. Follow the repository's `AGENTS.md` when using coding agents.

Installation does not configure your agents. Run `grafly init --dry-run` before
opting in, or `grafly hooks --dry-run` to preview global hook changes. Never commit
credentials, private indexes, service archives or personal deployment paths.
Please use the [security reporting instructions](SECURITY.md) for vulnerabilities.
