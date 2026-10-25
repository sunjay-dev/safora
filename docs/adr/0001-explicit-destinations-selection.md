# Explicit DESTINATIONS selection for multi-destination delivery

A run can deliver its archive to multiple destinations at once (an R2 bucket and a local folder today), selected by an explicit `DESTINATIONS` list (default `r2`). We rejected presence-based activation — enabling whatever happens to be configured — because for a backup tool a forgotten secret must fail loudly rather than silently produce a run with no offsite copy. Each selected destination's configuration is validated before the run starts, every selected destination is attempted even if another fails, and the run exits non-zero if any selected destination fails.

## Considered Options

- **Presence-based activation** (R2 active iff R2 vars are set, local active iff `LOCAL_BACKUP_DIR` is set): rejected — a missing secret silently downgrades the backup instead of failing the run.
