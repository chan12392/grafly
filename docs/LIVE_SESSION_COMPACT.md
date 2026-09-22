# Retired: session compaction

Removed on 2026-09-22 at the owner's request because the feature was unstable.
The session_compact channel, session host bridge, and Grafly session commands
are no longer shipped. Use [tool_output](TOOL_OUTPUT.md) for new command output.
Existing rollouts, archive directories and manifests have not been modified.
Historical implementations and restoration code remain in Git history; the new
runner does not read, rewrite or restore old session archives.
