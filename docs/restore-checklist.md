# Restore checklist

Work through this end-to-end **once, against a scratch cluster, before you actually need a backup.** A backup that has never been restored is a hope,
not a backup.

## What you need

- `age` and the **private key** (`key.txt`, the `AGE-SECRET-KEY-1...` line). The public key in `AGE_RECIPIENT` cannot decrypt.
- MongoDB Database Tools (`mongorestore`) when restoring MongoDB backups.
- PostgreSQL client tools (`pg_restore`, PostgreSQL 17) when restoring PostgreSQL backups.
- R2 credentials with Object Read (the same bucket-scoped token works), the R2 endpoint URL (same value as your `R2_ENDPOINT` secret, e.g.
  `https://<account>.r2.cloudflarestorage.com`), and the AWS CLI — or download the object from the Cloudflare dashboard, or use rclone (config below).

## 1. Find the backup

The run's step summary (GitHub → Actions → the run, under either the `backup` job for MongoDB or the `postgres` job for PostgreSQL) lists the object
key and SHA-256 for each database. To list everything instead:

```bash
aws s3 ls s3://mongodb-backups/backups/ \
  --endpoint-url <R2_ENDPOINT>
```

Archives follow engine-embedded naming under the shared `backups/` prefix:

- MongoDB: `backups/mongodb-<YYYY-MM-DDTHHMMSSZ>.archive.gz.age`
- PostgreSQL: `backups/postgres-<database>-<YYYY-MM-DDTHHMMSSZ>.dump.age`

For a local destination, locate the archive in `LOCAL_BACKUP_DIR` by its object key. The local archive uses the same object key as the R2 archive.

## 2. Download, verify, decrypt

```bash
export AWS_ACCESS_KEY_ID=<R2 access key id>
export AWS_SECRET_ACCESS_KEY=<R2 secret access key>

# MongoDB
aws s3 cp s3://mongodb-backups/backups/<MONGODB_OBJECT_KEY> ./backup.archive.gz.age \
  --endpoint-url <R2_ENDPOINT>

# PostgreSQL (per-database archive, e.g. for database 'app_db')
aws s3 cp s3://mongodb-backups/backups/<POSTGRES_OBJECT_KEY> ./postgres-app_db.dump.age \
  --endpoint-url <R2_ENDPOINT>

# Integrity check — this hash is of the ENCRYPTED file, and matches both the
# run's step summary and the object's x-amz-meta-sha-256 metadata.
sha256sum backup.archive.gz.age
sha256sum postgres-app_db.dump.age

# Decrypt with age (producing uncompressed custom-format dump for Postgres or gzipped archive for MongoDB)
age -d -i key.txt -o dump.archive.gz backup.archive.gz.age
age -d -i key.txt -o postgres-app_db.dump postgres-app_db.dump.age
```

`age -d` succeeding is itself proof the archive decrypts with your key.

When restoring from `LOCAL_BACKUP_DIR`, skip the R2 download and use the local archive file as input to the integrity check and decryption. For
example:

```bash
sha256sum "$LOCAL_BACKUP_DIR/<OBJECT_KEY>"
age -d -i key.txt -o dump.archive.gz "$LOCAL_BACKUP_DIR/<MONGODB_OBJECT_KEY>"
# or for PostgreSQL:
age -d -i key.txt -o postgres-app_db.dump "$LOCAL_BACKUP_DIR/<POSTGRES_OBJECT_KEY>"
```

### rclone alternative

```ini
# rclone config — [r2] section
[r2]
type = s3
provider = Cloudflare
access_key_id = <R2 access key id>
secret_access_key = <R2 secret access key>
endpoint = <R2_ENDPOINT>
acl = private
no_check_bucket = true
```

```bash
rclone copy r2:mongodb-backups/backups/<OBJECT_KEY> . --include "*.age"
```

## 3. Restore (scratch cluster first)

### MongoDB restore

```bash
# Validate the archive without writing anything
mongorestore --uri "mongodb+srv://<scratch-cluster>" --archive=dump.archive.gz --gzip --oplogReplay --dryRun

# Real restore (add --drop if restoring over an existing copy of the data)
mongorestore --uri "mongodb+srv://<scratch-cluster>" --archive=dump.archive.gz --gzip --oplogReplay
```

Notes:

- Dumps are taken with `--oplog`, so `--oplogReplay` restores to a consistent point in time rather than the ragged state of "whenever each collection
  happened to finish".
- Restoring to the production cluster is the same command with the production URI — only after the scratch restore checks out.

### PostgreSQL restore

The PostgreSQL backup pipeline dumps every non-template, connectable database on the server into its own custom-format archive
(`pg_dump --format=custom`, `-Fc`). Per ADR-0003, cluster-wide global objects (roles, users, and permissions) are **not** exported in the backup
archive, as doing so would require storing a superuser credential in GitHub Actions secrets. Restore is performed per-database.

#### Step 3a. Recreate roles and database manually

Before restoring into a scratch or replacement cluster, connect as an administrative user (e.g. `postgres`) and recreate the application roles,
database, and permissions:

```sql
-- Connect to the PostgreSQL instance as an administrative user:
-- psql "postgresql://postgres:<admin-password>@<target-host>:5432/postgres"

-- Recreate application and backup roles
CREATE ROLE app_user WITH LOGIN PASSWORD '<application-password>';
CREATE ROLE backup WITH LOGIN PASSWORD '<backup-password>';
GRANT pg_read_all_data TO backup;

-- Create target database with the appropriate owner if it does not exist
CREATE DATABASE app_db OWNER app_user;
```

#### Step 3b. Validate archive contents without writing anything

Use `pg_restore --list` to inspect the table of contents and verify that the database archive is intact and readable:

```bash
pg_restore --list postgres-app_db.dump
```

#### Step 3c. Restore to database

Run `pg_restore` against your target database. Use `--clean` and `--if-exists` to cleanly drop database objects before recreating them if restoring
into a database that already contains schema objects:

```bash
pg_restore --dbname="postgresql://postgres:<password>@<scratch-host>:5432/app_db" \
  --clean --if-exists postgres-app_db.dump
```

#### Parallel restore options

Because the backup uses PostgreSQL's custom archive format (`--format=custom`), `pg_restore` supports parallel multi-job restores using `-j` /
`--jobs`. This concurrently restores data and builds indexes across multiple worker connections, drastically reducing restore time for larger
databases:

```bash
pg_restore --dbname="postgresql://postgres:<password>@<scratch-host>:5432/app_db" \
  --jobs=4 --clean --if-exists postgres-app_db.dump
```

> **Note:** Parallel restore runs concurrent sessions against the target database. Ensure `max_connections` on the target database is sufficient to
> handle the specified number of jobs plus administrative connections.

#### Selective restore options

The custom archive format allows restoring individual schemas, tables, or sections:

- **Restore specific table(s)** (`-t` / `--table`):

  ```bash
  pg_restore --dbname="postgresql://..." --table=orders --table=customers postgres-app_db.dump
  ```

- **Restore a specific schema** (`-n` / `--schema`):

  ```bash
  pg_restore --dbname="postgresql://..." --schema=public postgres-app_db.dump
  ```

- **Restore schema definitions only (no data)**:

  ```bash
  pg_restore --dbname="postgresql://..." --schema-only postgres-app_db.dump
  ```

- **Restore table data only (no schema creation)**:

  ```bash
  pg_restore --dbname="postgresql://..." --data-only postgres-app_db.dump
  ```

- **Restore by section** (`--section=pre-data|data|post-data`):

  ```bash
  # Restore table definitions and types (pre-data)
  pg_restore --dbname="postgresql://..." --section=pre-data postgres-app_db.dump

  # Restore table contents (data)
  pg_restore --dbname="postgresql://..." --section=data postgres-app_db.dump

  # Restore indexes and constraints (post-data)
  pg_restore --dbname="postgresql://..." --section=post-data postgres-app_db.dump
  ```

- **Selective restore using a table of contents list file** (`-L` / `--use-list`): Generate the list of items from the archive:
  ```bash
  pg_restore --list postgres-app_db.dump > restore.list
  ```
  Edit `restore.list` in a text editor to comment out items you do not wish to restore (lines beginning with `;` are ignored by `pg_restore`), or
  rearrange item order:
  ```bash
  pg_restore --dbname="postgresql://..." --use-list=restore.list postgres-app_db.dump
  ```

## 4. Sanity checks

- Document counts (MongoDB) or table row counts (PostgreSQL) on your critical collections / tables match expectations:
  ```sql
  SELECT count(*) FROM users;
  ```
- Application read-path smoke test against the scratch cluster / database.
- Write down how long the whole procedure took — that is your real recovery time, not an estimate.

## 5. Key escrow

- Losing `key.txt` makes **every existing backup permanently unreadable**. Keep an offline copy (password manager + physical/offline medium).
- To rotate keys: generate a new pair, update the `AGE_RECIPIENT` secret, keep the old private key until all backups made with it have aged out of
  retention. Stored backups are not re-encrypted automatically.
