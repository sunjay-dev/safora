# mongodb-backups

Encrypted MongoDB backups delivered to one or more destinations, run from GitHub Actions or a local machine.

## Language

**Run**: One execution of the backup pipeline, producing one verified archive per database (one for MongoDB, one per non-template database for
PostgreSQL). _Avoid_: Execution, job

**Dump**: The unencrypted database snapshot produced during a run; it exists only in the run's temporary workspace and is never delivered anywhere.
_Avoid_: Archive (reserved for the encrypted artifact)

**Archive**: The encrypted artifact built from a run's dump; the only completed artifact ever written to a destination. _Avoid_: Backup file, dump

**Staging file**: An incomplete `<object-key>.part` copy written inside a local destination before its SHA-256 is verified and it is renamed to the
object key. _Avoid_: Temp file

**Destination**: A place a run delivers its archive. A run may deliver to several destinations at once; today an R2 bucket or a local folder. _Avoid_:
Storage, backend, target

**Delivery**: Writing an archive to a destination and verifying the written copy matches the source. _Avoid_: Upload (R2-specific), copy (unverified)

**Venue**: Where a run executes — a GitHub Actions runner or a local machine. Independent of destinations: any venue can deliver to any combination of
destinations. _Avoid_: Runner, environment, machine

**Engine**: The database product a run backs up — mongodb or postgres. Each run executes exactly one engine; a scheduled workflow may run jobs for
several engines in parallel. _Avoid_: Database (the data itself), driver, dialect

**Object key**: An archive's location within a destination. One archive has the same object key in every destination. _Avoid_: Path, filename, prefix

**Retention**: The rule that deletes delivered archives older than the configured number of days, applied independently per destination. _Avoid_:
Cleanup, expiry
