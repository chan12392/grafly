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

Grafly does not automatically load a repository `.env`. Supply configuration in
the invoking shell or through the agent's existing login. Prefer `GRAFLY_API_KEY`
(or the documented provider environment variable) over `--api-key`: command-line
arguments may be visible in process listings and shell history.

Opening a checkout does not authorize changing user-level agent configuration.
Refresh installed generated shims explicitly with `grafly hooks` after updating.
Hooks do not grant blanket shell permissions. Daily source updates are off unless
`GRAFLY_AUTO_UPDATE=1` is explicitly set; automatic structural indexing only
considers Git checkouts. Use `grafly build <dir>` for other folders.
Hook installation rejects paths containing shell expansion characters.

Index/config writers reject symlinked descendants of trusted runtime roots, and workspace children must remain
inside their parent checkout. Corrupt Markdown cards are skipped with a warning
and preserved. Hook input is limited to 1 MiB, JSON state to 64 MiB, and source
files read by grep to 1 MiB. Regex matching has a two-second worker budget;
`--fixed` avoids regex execution. PDF parsing/rendering runs in a worker with a
ten-second budget, separate from optional model requests, plus page/text limits.
The output-hook installer retains its five most recent backups.

The optional comparison feed does not receive the process environment.
Sensitive filenames are excluded from material indexing and comparison reads;
this is additional filtering, not a substitute for reviewing the content you send.

`allowScripts` is supported by current npm versions and is intentionally retained
([npm documentation](https://docs.npmjs.com/cli/using-npm/config/#allow-scripts)).
Older clients may not enforce it; `--ignore-scripts` can be used when inspecting
an untrusted package, with native build steps reviewed separately. The legacy
`stamp-telemetry-key.mjs` utility is not connected to installation or publishing.
