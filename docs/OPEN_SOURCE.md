# Release preparation

Grafly is MIT licensed; preserve `LICENSE` and `THIRD_PARTY_NOTICES`. The graph
engine originated in Graft 0.18.0. Grafly is independently maintained. The removed
D3 viewer is not a runtime dependency; its historical attribution is retained.

## Publication boundary

The current source contains the local CLI, graph/search engine, optional native
XERJ adapter, inference circuit and local Brain miner. MoreCoffee's training and
signed-runtime distribution remain separate. Without that optional runtime,
Grafly keeps its documented local/fallback behavior.

Legacy Brain HTTP/storage code, server tests, Oracle deployment files, runtime
data and operational archives are managed outside this current tree. Local rule,
index and output caches are private. They are not release inputs.

**Making the existing repository public also exposes its Git history.** Earlier
commits contain the retired server, viewer and historical telemetry configuration.
Removing present-day files does not remove those versions. Keep the existing
repository private until that historical disclosure is explicitly accepted, or
publish a reviewed source snapshot with fresh history. Preserve the old history
privately before any authorized rewrite; do not force-push it as routine cleanup.
Review GitHub Actions logs/artifacts, issues, PRs and release assets separately.

## Reproducible package

1. Start from a clean source snapshot with no credentials or runtime data.
2. Run `npm ci`, `npm audit`, and `npm test` on Node 22 and 24.
3. For optional native search, run `npm run build:xerj` with Rust and a C linker.
4. Inspect `npm pack --dry-run --json` and test the resulting package in a clean
   directory: build a small repository, then run `ask --source` and `callers`.
5. Scan both the current release snapshot and any Git history being published
   with a dedicated secret scanner. Investigate each finding; a clean snapshot
   scan is not evidence that the historical repository is safe to disclose.

Packages deliberately exclude locally compiled `.node` files and source maps.
They include the Rust sources and lockfile so users can build for their own OS
and architecture. Native dependencies downloaded by npm/Cargo retain their own
licenses. Public documentation ships with the package so relative links work.

Installation does not change global agent settings. `grafly init` and `grafly
hooks` are explicit opt-ins; existing integrations keep working. Telemetry and
registry checks remain disabled unless explicitly configured. No shared Brain
service or Oracle account is required.

CI covers Windows/Linux and Node 22/24. Local checks only establish the platforms
actually run; macOS/ARM and live optional MoreCoffee/Codex integrations need their
own evidence. Dependency advisories can change after a successful audit.
