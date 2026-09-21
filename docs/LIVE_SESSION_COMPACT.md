# MC live compaction compatibility entry

The implementation now belongs to MoreCoffee's `session_compact` channel and
its `morecoffee/channels/session_host/` adapter. Grafly only forwards the live
entry point; it does not own a separate live compaction engine.

Use MoreCoffee directly (Grafly is unnecessary):

```powershell
python -m morecoffee.channels.session_host --codex "C:/path/to/codex.exe" --archive-dir "C:/private/mc-live"
```

The existing Grafly command remains available when MoreCoffee is installed in
the selected Python environment, or when `MC_ROOT` points to its source checkout:

```powershell
$env:MC_ROOT = "C:/path/to/morecoffee"
grafly session-live --codex "C:/path/to/codex.exe" --archive-dir "C:/private/mc-live"
```

`MC_PYTHON` selects the Python executable; the default is `python`. Missing MC
fails instead of silently falling back to old rules. See MoreCoffee's
`docs/LIVE_SESSION_COMPACT.md` for the protocol, backup/recovery, supported
Codex versions, limitations, and real-model evaluation.

`session-compact`/`session-expand` remain the existing standalone file commands.
Installing either package does not attach an adapter to the current Orca thread.

Grafly compatibility verification:

```powershell
$env:MC_ROOT = "C:/path/to/morecoffee"
$env:GRAFLY_TEST_CODEX = "C:/path/to/codex.exe"
npm test
```
