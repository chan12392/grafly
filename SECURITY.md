# Security

Use a supported Node.js release (>=22.12.0) and the current Grafly source.
Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/chan12392/grafly/security/advisories/new).
If private reporting is unavailable, open an issue asking for a private channel
without publishing exploit details, repository contents, credentials or logs.

Basic graph building and retrieval work locally without an API key. Optional
deep indexing, vision, naming and Brain mining send their inputs to the model
you configure. An HTTP endpoint on localhost can itself proxy to a cloud model.
An explicitly configured remote XERJ receives queries and indexed content.
Telemetry requires an explicit key and is disabled by default.

Keep `.env`, `.grafly/`, service data and operational backups private. Digest,
rule and raw-output files can contain sensitive repository material. Do not
attach these to public issues without reviewing and redacting them. A read-only
query does not guarantee offline operation; use `--no-xerj` to bypass a configured
remote search backend.

Before publishing, run `npm ci`, `npm audit`, `npm test`, a dedicated secret scan
of the working tree and Git history, and inspect `npm pack --dry-run`. Historical
commits, Actions logs and artifacts need their own review; deleting a current
file does not remove past copies. See [release preparation](docs/OPEN_SOURCE.md).
