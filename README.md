# mongodb-backups

Daily, encrypted MongoDB Atlas and PostgreSQL backups delivered to S3-compatible storage (AWS S3, Cloudflare R2, MinIO, etc.) and/or a local folder,
run from GitHub Actions or a local machine. A Node.js + TypeScript orchestrator runs the pipeline: `mongodump` creates a single cluster archive or
`psql` enumerates non-template databases and `pg_dump` creates an archive per database, `age-encryption` encrypts each in-process, and each selected
destination stores and verifies it (S3 through the AWS SDK for JavaScript v3, no AWS CLI subprocess). Expired backups are pruned automatically per
destination.

**Keep this repository private.** The archive is encrypted client-side before it leaves the runner — storage providers and anyone with access to the
bucket only ever sees ciphertext.

## Architecture

```
GitHub Actions (cron 00:00 UTC = 05:00 PKT, or manual dispatch)
├── Job 1: backup (MongoDB)
│   └── Node.js orchestrator — src/main.ts (ENGINE=mongodb)
│       ├── mongodump (MongoDB Database Tools) → single gzipped archive, point-in-time via --oplog
│       │     └── URI supplied via a chmod-600 temp config file — never a command-line argument
│       ├── age encryption (in-process via age-encryption; recipient = AGE_RECIPIENT public key)
│       └── destinations (s3, local), attempted in listed order (src/destinations/)
│             ├── s3: AWS SDK v3 → multipart upload to S3-compatible storage → HeadObject verification (size must match)
│             │     └── retention: delete backups/ objects older than RETENTION_DAYS
│             └── local: copy to <object-key>.part → SHA-256 verification → rename
│                   └── retention: delete expired archives under LOCAL_BACKUP_DIR by mtime
└── Job 2: postgres (PostgreSQL)
    └── Node.js orchestrator — src/main.ts (ENGINE=postgres)
        ├── psql (PostgreSQL Client Tools) → enumerates connectable non-template databases
        └── for each database:
            ├── pg_dump (PostgreSQL Client Tools) → custom-format archive (-Fc) validated with pg_restore --list
            │     └── URI connection args without password; password via chmod-600 temp PGPASSFILE (database wildcard)
            ├── age encryption (in-process via age-encryption; recipient = AGE_RECIPIENT public key)
            └── destinations (s3, local), attempted in listed order (same downstream pipeline)
```

Objects land at:

- `s3://<S3_BUCKET>/backups/mongodb/<YYYY-MM-DD_HH-MM-SS>/mongodb.archive.gz.age` (or `<database>.archive.gz.age` when `MONGODB_DB_BLOCKLIST` is set)
- `s3://<S3_BUCKET>/backups/postgres/<YYYY-MM-DD_HH-MM-SS>/<database>.dump.age`

Each carrying its SHA-256 as `x-amz-meta-sha-256` metadata. The local destination mirrors the same object key under `LOCAL_BACKUP_DIR`.

## Repository layout

```
mongodb-backups/
├── .github/workflows/backup.yml   # scheduler: daily 00:00 UTC + manual dispatch (parallel MongoDB & PostgreSQL jobs)
├── src/
│   ├── main.ts                    # pipeline orchestration + top-level error handling
│   ├── config/
│   │   ├── env.config.ts          # Zod schema: engine selection, required secrets, tunables with defaults
│   │   └── env.config.test.ts     # config loading, ENGINE validation, and environment matrix tests
│   ├── destinations/
│   │   ├── destination.ts         # Destination contract: identifier + delivery + prune
│   │   ├── deliver.ts             # sequential fan-out, failure collection, per-destination outcomes
│   │   ├── index.ts               # destination list built from DESTINATIONS
│   │   ├── local.ts               # local-folder implementation: atomic copy + mtime retention
│   │   └── s3.ts                  # S3 implementation: client + upload + retention
│   ├── logging.ts                 # log + fail + URI & password redaction
│   ├── summary.ts                 # per-destination summary: GitHub step summary or stdout
│   ├── tools.ts                   # preflight tool checks (mongodump for MongoDB; psql, pg_dump, and pg_restore for PostgreSQL)
│   ├── lib/
│   │   ├── exec.ts                # execFile wrapper + child-output extraction
│   │   ├── format.ts              # object-key assembly, sizes
│   │   ├── format.test.ts         # archive object-key layout tests
│   │   ├── hash.ts                # SHA-256 of files
│   │   ├── postgres.ts            # URI split, PGPASSFILE lifecycle, psql enumeration args, pg_dump/pg_restore args
│   │   └── postgres.test.ts       # URI-split matrix + security invariant tests
│   ├── steps/
│   │   ├── dump.ts                # dump step branching on ENGINE: mongodump or psql enumeration + pg_dump per database + verify
│   │   └── encrypt.ts             # in-process age encryption
│   └── storage/
│       ├── client.ts              # S3-compatible S3Client factory
│       ├── retention-policy.ts    # shared retention selection (pure)
│       ├── retention-policy.test.ts # cutoff, current-key, empty-input tests
│       ├── retention.ts           # prune objects older than RETENTION_DAYS
│       └── upload.ts              # multipart upload + verification
├── docs/
│   ├── adr/                       # architecture decision records (e.g. ADR-0004 for S3-compatible storage)
│   └── restore-checklist.md       # do this once against a scratch cluster / database
├── .env.example                   # local-run template (gitignored as .env)
├── .gitignore
├── .prettierrc / .prettierignore  # Prettier config (150-col); pnpm format to apply
├── package.json
├── tsconfig.json
├── tsconfig.test.json             # typechecks source + tests without emitting
└── README.md
```

## One-time setup

1. **Repository** — create the _private_ repo `mongodb-backups` and push these files.
2. **age keys** — install [age](https://github.com/FiloSottile/age), then `age-keygen -o key.txt`:
   - the `# public key: age1...` line → GitHub secret `AGE_RECIPIENT`
   - the `AGE-SECRET-KEY-1...` private line → store offline (password manager / offline media). **If you lose it, every backup is unrecoverable.**
     Never commit it.
3. **S3-compatible storage bucket** — create a private bucket (e.g. `mongodb-backups`) with your chosen storage provider:
   - **AWS S3**: create a bucket in your chosen region (e.g. `us-east-1`). Configure IAM least-privilege credentials or OIDC role with `s3:PutObject`,
     `s3:GetObject`, `s3:ListBucket`, and `s3:DeleteObject`.
   - **Cloudflare R2**: create the bucket `mongodb-backups`; then under R2 → Manage R2 API Tokens → Create API Token → permission _Object Read &
     Write_, scope _apply to specific bucket only_ → `mongodb-backups`. Note the Access Key ID, Secret Access Key, and Account ID.
   - **MinIO / Self-Hosted**: create a bucket and access key / secret key with read/write access.
4. **GitHub secrets** (Settings → Secrets and variables → Actions → _Secrets_):
   - `MONGODB_URI`: connection string for MongoDB Atlas backup user.
   - `POSTGRESQL_URI`: connection URI for PostgreSQL backup role.
   - `AGE_RECIPIENT`: public key (`age1...`).
   - `S3_ENDPOINT`: endpoint URL with protocol (required for Cloudflare R2 and MinIO, e.g. `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`; omit for
     standard AWS regional endpoints).
   - `S3_ACCESS_KEY_ID`: access key ID (required when using static credentials; omit when using ambient AWS IAM roles or GitHub Actions OIDC).
   - `S3_SECRET_ACCESS_KEY`: secret access key (required when using static credentials; omit when using ambient AWS IAM roles or GitHub Actions OIDC).
5. **GitHub variables** (same page → _Variables_):
   - `S3_BUCKET`: bucket name (e.g. `mongodb-backups`; required when destination includes `s3`).
   - `S3_REGION`: region (e.g. `auto` for Cloudflare R2, or AWS region such as `us-east-1`; optional, omitted to delegate region resolution to the AWS
     SDK).
   - `S3_FORCE_PATH_STYLE`: set to `true` if your provider requires path-style addressing (e.g. MinIO, LocalStack; defaults to `false`).
   - `DESTINATIONS`: comma-separated destinations to deliver to (`s3`, `local`). Unset or blank defaults to `s3`.
   - Pipeline tunables with sane defaults: `RETENTION_DAYS` (30), `LOG_LEVEL` (info), `BACKUP_PREFIX` (backups/), `DUMP_TIMEOUT_MS` (1200000),
     `TOOL_CHECK_TIMEOUT_MS` (30000), and `MAX_BUFFER` (10485760). In CI, `ENGINE` is set automatically per job (`mongodb` for the MongoDB job,
     `postgres` for the PostgreSQL job). See `.env.example` for details.
   - Optional database exclusions: `MONGODB_DB_BLOCKLIST`, `PG_DB_BLOCKLIST`, or `DB_BLOCKLIST`.
6. **Legacy R2 fallback behavior** — For existing deployments configured with Cloudflare R2 secrets and variables, `.github/workflows/backup.yml`
   provides backward compatibility fallbacks:
   - `S3_ENDPOINT` falls back to `secrets.R2_ENDPOINT`
   - `S3_ACCESS_KEY_ID` falls back to `secrets.R2_ACCESS_KEY_ID`
   - `S3_SECRET_ACCESS_KEY` falls back to `secrets.R2_SECRET_ACCESS_KEY`
   - `S3_BUCKET` falls back to `vars.R2_BUCKET` Existing repositories continue running without interruption while allowing gradual migration to
     canonical `S3_*` names.
7. **MongoDB Atlas setup** — dedicated backup user with the built-in `backup` role. Network Access: GitHub-hosted runners use rotating IPs, so either
   allow `0.0.0.0/0` (acceptable here because the user is limited to the backup role and the SRV string is SCRAM-protected) or self-host a runner with
   a static IP you can allowlist. Take the SRV connection string for that user → secret `MONGODB_URI`.
8. **PostgreSQL setup** — create the dedicated backup role, configure public-endpoint TLS, and store the connection URI:
   - **Backup-role creation**: connect to your PostgreSQL 17 instance with an administrative user and create a dedicated role with least-privilege
     read access:
     ```sql
     CREATE ROLE backup WITH LOGIN PASSWORD '<strong-password>';
     GRANT pg_read_all_data TO backup;
     ```
     The predefined `pg_read_all_data` role (PostgreSQL 14+) grants read-only access across all tables, views, and schemas without superuser
     privileges.
   - **Connection URI & Public-Endpoint TLS guidance**: construct your connection URI pointing to the maintenance database (`postgres`):
     ```text
     postgresql://backup:<strong-password>@<vps-host>:5432/postgres?sslmode=require
     ```
     The pipeline respects `POSTGRESQL_URI` verbatim — any supported `sslmode` query parameter is honored as passed and the string is never silently
     rewritten. The path names the maintenance database used to enumerate all connectable, non-template databases; each enumerated database is backed
     up into its own archive.
     > **Warning on libpq default `sslmode=prefer`:** PostgreSQL's libpq defaults to `sslmode=prefer` when `sslmode` is omitted from the URI. With
     > `sslmode=prefer`, libpq first attempts an encrypted connection, but **silently falls back to an unencrypted, plaintext connection** if the
     > server does not enforce TLS. When backing up an endpoint that is publicly reachable over the internet, you should explicitly set
     > `sslmode=require` in the URI to prevent any unencrypted fallback. If certificate verification is configured, use `sslmode=verify-full` (or
     > `verify-ca`) to prevent man-in-the-middle attacks by verifying the server certificate.
   - Inbound IP restriction at the host/VPS firewall is also strongly recommended where practical.
   - Save the resulting connection string to GitHub secret `POSTGRESQL_URI`.
9. **First run** — Actions → **MongoDB Atlas Backup** → Run workflow. Both `backup` and `postgres` jobs will run in parallel.

## Provider configuration examples

### 1. AWS S3 (Native)

With static IAM credentials:

```env
S3_BUCKET=my-backup-bucket
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
S3_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
# S3_ENDPOINT is omitted for native AWS regional endpoints
# S3_FORCE_PATH_STYLE defaults to false
```

With ambient credentials (IAM role, ECS task role, or GitHub Actions OIDC):

```env
S3_BUCKET=my-backup-bucket
S3_REGION=us-east-1
# S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are omitted.
# The AWS SDK resolves credentials ambiently from the environment or instance profile.
```

### 2. Cloudflare R2

```env
S3_BUCKET=mongodb-backups
S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_REGION=auto
S3_ACCESS_KEY_ID=<R2_TOKEN_ACCESS_KEY_ID>
S3_SECRET_ACCESS_KEY=<R2_TOKEN_SECRET_ACCESS_KEY>
```

For EU-jurisdiction buckets, use `https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com`.

### 3. MinIO / Self-Hosted S3

```env
S3_BUCKET=backups
S3_ENDPOINT=https://minio.example.com
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
S3_FORCE_PATH_STYLE=true
```

## Running

- **Manual**: Actions → MongoDB Atlas Backup → Run workflow. Both the MongoDB (`backup`) and PostgreSQL (`postgres`) jobs run concurrently.
- **Scheduled**: daily at 00:00 UTC (05:00 Pakistan time). The two parallel jobs run independently on the same schedule; either job failing leaves the
  other green, with independent failure notifications and step summaries. Midnight UTC is a busy time for GitHub's schedulers, so runs may start
  several minutes late — but it still fires once per day.
- **Failure behavior**: any failed step fails the job loudly; no destination is written unless dump and encryption both succeeded. A run that selects
  several destinations attempts all of them and still exits non-zero if any destination fails. In PostgreSQL, all enumerated databases are attempted,
  failures are collected, and successful databases' archives are still delivered even if another database fails. Each successful job's summary lists
  the object key, encrypted size, SHA-256, and pruned objects per destination; outside GitHub Actions it prints to stdout.
- GitHub disables scheduled workflows after **60 days of repository inactivity** — any commit re-enables it. Watch for the notification email.

## Local run

Requires Node.js 22.12 or later and [pnpm](https://pnpm.io/installation) (or `corepack enable`, which reads the pinned version from `package.json`).
The CLI tools for your chosen engine (`mongodump` for MongoDB; `psql`, `pg_dump`, and `pg_restore` for PostgreSQL) must also be available on your
`PATH`.

On Windows, install the command-line tools before running a backup:

- **MongoDB Database Tools** (includes `mongodump` and `mongorestore`): download the Windows x86_64 ZIP from the
  [MongoDB Database Tools Download Center](https://www.mongodb.com/try/download/database-tools). Extract it and add its `bin` folder to your `PATH`.
  Open a new terminal and confirm the install with `mongodump --version`.
- **PostgreSQL 17 Client Tools** (includes `psql`, `pg_dump`, and `pg_restore`): download the Windows installer for PostgreSQL 17 from the
  [PostgreSQL Windows Downloads](https://www.postgresql.org/download/windows/) (or the command-line binaries zip from EnterpriseDB). During setup with
  the installer, you can uncheck the server components and install only "Command Line Tools". Add the installation's `bin` directory (typically
  `C:\Program Files\PostgreSQL\17\bin`) to your system `PATH`. Open a new terminal and confirm the install:
  ```text
  psql --version
  pg_dump --version
  pg_restore --version
  ```
  Alternatively, you can install PostgreSQL 17 via Windows Package Manager:
  ```text
  winget install PostgreSQL.PostgreSQL.17
  ```
  and ensure its `bin` directory is added to your `PATH`.

Copy `.env.example` to `.env` and fill in the values for your run.

- For MongoDB (default): ensure `ENGINE=mongodb` (or omit `ENGINE`) and provide `MONGODB_URI`.
- For PostgreSQL: set `ENGINE=postgres` and provide `POSTGRESQL_URI`.

For a run with only the local destination, set `DESTINATIONS=local` and choose `LOCAL_BACKUP_DIR`; S3 credentials are needed only when `DESTINATIONS`
includes `s3`. The `backup:local` command loads `.env` when present, builds the pipeline, and runs it. This command is the same in PowerShell, Command
Prompt, and bash:

```text
pnpm install
pnpm run backup:local
```

`pnpm run backup` remains the CI-shaped command and does not load `.env`. Selecting `local` in GitHub Actions writes an archive that disappears when
the workflow finishes, so that destination is generally meaningless in CI.

Logs are structured JSON (pino), one object per line — greppable in CI and easy to ship elsewhere. Set `LOG_LEVEL` (default `info`) to adjust
verbosity. For readable local output, pipe through pino-pretty:

```bash
pnpm run backup | pnpm dlx pino-pretty
```

## Verify a backup without restoring

For MongoDB:

```bash
# AWS S3
aws s3 cp s3://<S3_BUCKET>/backups/mongodb/<TIMESTAMP>/mongodb.archive.gz.age backup.archive.gz.age

# Cloudflare R2 / MinIO (custom endpoint)
aws s3 cp s3://<S3_BUCKET>/backups/mongodb/<TIMESTAMP>/mongodb.archive.gz.age backup.archive.gz.age \
  --endpoint-url <S3_ENDPOINT>

age -d -i key.txt -o dump.archive.gz backup.archive.gz.age
```

For PostgreSQL (per-database archive):

```bash
# AWS S3
aws s3 cp s3://<S3_BUCKET>/backups/postgres/<TIMESTAMP>/<DATABASE>.dump.age postgres-<DATABASE>.dump.age

# Cloudflare R2 / MinIO (custom endpoint)
aws s3 cp s3://<S3_BUCKET>/backups/postgres/<TIMESTAMP>/<DATABASE>.dump.age postgres-<DATABASE>.dump.age \
  --endpoint-url <S3_ENDPOINT>

age -d -i key.txt -o postgres-<DATABASE>.dump postgres-<DATABASE>.dump.age
pg_restore --list postgres-<DATABASE>.dump
```

A successful `age -d` proves the archive decrypts with your key (and `pg_restore --list` verifies the decrypted PostgreSQL custom-format archive table
of contents). The full download → verify → restore procedure lives in [docs/restore-checklist.md](docs/restore-checklist.md).

## Security model

- Client-side encryption before upload (in-process via `age-encryption`, X25519) — a compromise of S3 storage or the API token exposes ciphertext
  only.
- Credential isolation:
  - `MONGODB_URI` reaches `mongodump` through a temporary chmod-600 config file, deleted immediately after the dump.
  - `POSTGRESQL_URI` is split so that connection arguments carry only the stripped URI; the password is provided through a temporary chmod-600
    `PGPASSFILE` with a database wildcard covering all enumerated databases, deleted immediately after the run.
  - Passwords never appear in process listings, command lines, or shell history.
- Redaction layer: logs go through pino with a stream that scrubs `MONGODB_URI`, `POSTGRESQL_URI`, and extracted passwords from every line before it
  is written, and error messages are sanitized before they are thrown.
- Least privilege on every path: S3 token scoped to the single bucket; Atlas user limited to the `backup` role; PostgreSQL role limited to
  `pg_read_all_data`; workflow granted only `contents: read`.
- Dump artifacts are never uploaded as GitHub Actions artifacts; the temp workdir (which briefly holds the plaintext dump) is always removed.

## Caveats

- This repository is prepared but **not yet tested against your actual Atlas cluster, PostgreSQL server, or S3 bucket**. Run it manually, confirm the
  encrypted object appears in S3, and complete a test restore before relying on it.
- The 30-minute job timeout and 20-minute dump timeout assume a small/medium database; raise both for larger data sets.
- Retention is enforced by this pipeline. An S3 / R2 lifecycle rule on `backups/` makes a decent second line of defense.
- Dependencies are pinned by the committed `pnpm-lock.yaml`; CI installs with `--frozen-lockfile`, so every run builds against exactly what was
  verified locally. Update the lockfile with `pnpm install` after changing `package.json`, and commit it together.
- Temporary credential files (`mongodump.conf` and `.pgpass`) are protected with `chmod 600` on POSIX systems. Windows does not enforce those Unix
  permission bits through this call, so this protection is largely a no-op there; keep the local account and temporary folder private.
- The PostgreSQL dump produces a custom-format archive (`-Fc`) per non-template database. Cluster-wide global objects (roles, users, tablespaces) are
  not included (avoiding superuser credentials in CI; ADR-0003); roles must be recreated manually before restore as documented in
  [docs/restore-checklist.md](docs/restore-checklist.md).
