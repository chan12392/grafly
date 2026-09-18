# Grafly telemetry

Telemetry is disabled by default in this private fork.

Grafly ships no baked PostHog key and the postinstall hook never sends an install
event. Network telemetry is possible only when an ingestion key is supplied
explicitly with `GRAFLY_POSTHOG_KEY` (or deprecated `GRAFT_POSTHOG_KEY`).

Set `DO_NOT_TRACK=1` to force telemetry off regardless of configuration.

The inherited event contract is intended for coarse operational metadata; source
code, file paths and query text are not part of the event contract.
