# mongodb-backups

Daily, encrypted MongoDB Atlas backups delivered to Cloudflare R2 and/or a local folder, run from GitHub Actions or a local machine. A Node.js + TypeScript orchestrator runs the whole pipeline: `mongodump` creates the archive, `age` encrypts it, and each selected destination stores and verifies it (R2 through the AWS SDK for JavaScript v3, no AWS CLI subprocess). Expired backups are pruned automatically per destination.

**Keep this repository private.** The archive is encrypted client-side before it leaves the runner — R2 and anyone with access to the bucket only ever sees ciphertext.

## Architecture

```
GitHub Actions (cron 00:00 UTC = 05:00 PKT, or manual run)
└── Node.js orchestrator — src/main.ts (env validated with Valibot in src/config/env.config.ts)
    ├── mongodump (MongoDB Database Tools) → single gzipped archive, point-in-time via --oplog
    │     └── URI supplied via a chmod-600 temp config file — never a command-line argument
    ├── age encryption (recipient = AGE_RECIPIENT public key)
    └── destinations, attempted in listed order (src/destinations/)
        ├── r2: AWS SDK v3 → multipart upload to R2 → HeadObject verification (size must match)
        │     └── retention: delete backups/ objects older than RETENTION_DAYS
        └── local: copy to <object-key>.part → SHA-256 verification → rename
              └── retention: delete expired archives under LOCAL_BACKUP_DIR by mtime
```

Objects land at `s3://<R2_BUCKET>/backups/mongodb-<YYYY-MM-DDTHHMMSSZ>.archive.gz.age`, each carrying its SHA-256 as `x-amz-meta-sha-256` metadata. The local destination mirrors the same object key under `LOCAL_BACKUP_DIR`.

## Repository layout

```
mongodb-backups/
├── .github/workflows/backup.yml   # scheduler: daily 00:00 UTC + manual dispatch
├── src/
│   ├── main.ts                    # pipeline orchestration + top-level error handling
│   ├── config/
│   │   └── env.config.ts          # Valibot schema: required secrets + tunables with defaults
│   ├── destinations/
│   │   ├── destination.ts         # Destination contract: identifier + delivery + prune
│   │   ├── deliver.ts             # sequential fan-out, failure collection, per-destination outcomes
│   │   ├── index.ts               # destination list built from DESTINATIONS
│   │   ├── local.ts               # local-folder implementation: atomic copy + mtime retention
│   │   └── r2.ts                  # R2 implementation: client + upload + retention
│   ├── logging.ts                 # log + fail + URI redaction
│   ├── summary.ts                 # per-destination summary: GitHub step summary or stdout
│   ├── tools.ts                   # mongodump/age preflight checks
│   ├── lib/
│   │   ├── exec.ts                # execFile wrapper + child-output extraction
│   │   ├── format.ts              # object-key assembly, sizes
│   │   ├── format.test.ts         # archive object-key layout tests
│   │   └── hash.ts                # SHA-256 of files
│   ├── steps/
│   │   ├── dump.ts                # mongodump → gzipped archive
│   │   └── encrypt.ts             # age encryption
│   └── storage/
│       ├── client.ts              # R2 S3Client factory
│       ├── retention-policy.ts    # shared retention selection (pure)
│       ├── retention-policy.test.ts # cutoff, current-key, empty-input tests
│       ├── retention.ts           # prune objects older than RETENTION_DAYS
│       └── upload.ts              # multipart upload + verification
├── docs/restore-checklist.md      # do this once against a scratch cluster
├── .env.example                   # local-run template (gitignored as .env)
├── .gitignore
├── .prettierrc / .prettierignore  # Prettier config (100-col); pnpm format to apply
├── package.json
├── tsconfig.json
├── tsconfig.test.json             # typechecks source + tests without emitting
└── README.md
```

## One-time setup

1. **Repository** — create the _private_ repo `mongodb-backups` and push these files.
2. **age keys** — install [age](https://github.com/FiloSottile/age), then `age-keygen -o key.txt`:
   - the `# public key: age1...` line → GitHub secret `AGE_RECIPIENT`
   - the `AGE-SECRET-KEY-1...` private line → store offline (password manager / offline media). **If you lose it, every backup is unrecoverable.** Never commit it.
3. **R2** — create the bucket `mongodb-backups`; then R2 → Manage R2 API Tokens → Create API Token → permission _Object Read & Write_, scope _apply to specific bucket only_ → `mongodb-backups`. Note the Access Key ID and Secret Access Key.
4. **GitHub secrets** (Settings → Secrets and variables → Actions → _Secrets_): `MONGODB_URI`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `AGE_RECIPIENT`. Build the endpoint as `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (Account ID is on the R2 overview page; EU-jurisdiction buckets use `https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com`).
5. **GitHub variables** (same page → _Variables_): set `R2_BUCKET` to `mongodb-backups`. The workflow reads `DESTINATIONS` here; unset or blank
   defaults to `r2`. Other variables are optional with sane defaults: `RETENTION_DAYS` (30), `LOG_LEVEL` (info), `BACKUP_PREFIX` (backups/),
   `DUMP_TIMEOUT_MS` (1200000), `ENCRYPT_TIMEOUT_MS` (600000), `TOOL_CHECK_TIMEOUT_MS` (30000), and `MAX_BUFFER` (10485760). See `.env.example` for
   what each does.
6. **Atlas** — dedicated backup user with the built-in `backup` role. Network Access: GitHub-hosted runners use rotating IPs, so either allow `0.0.0.0/0` (acceptable here because the user is limited to the backup role and the SRV string is SCRAM-protected) or self-host a runner with a static IP you can allowlist. Take the SRV connection string for that user → secret `MONGODB_URI`.
7. **First run** — Actions → **MongoDB Atlas Backup** → Run workflow.

## Running

- **Manual**: Actions → MongoDB Atlas Backup → Run workflow.
- **Scheduled**: daily at 00:00 UTC (05:00 Pakistan time). Midnight UTC is a busy time for GitHub's schedulers, so runs may start several minutes late — but it still fires once per day.
- **Failure behavior**: any failed step fails the job loudly; no destination is written unless encryption and dump both succeeded. A run that selects several destinations attempts all of them and still exits non-zero if any destination fails. Each successful run's summary lists the object key, encrypted size, SHA-256, and pruned objects per destination; outside GitHub Actions it prints to stdout.
- GitHub disables scheduled workflows after **60 days of repository inactivity** — any commit re-enables it. Watch for the notification email.

## Local run

Requires Node.js 22.12 or later and [pnpm](https://pnpm.io/installation) (or `corepack enable`, which reads the pinned version from `package.json`).
The `mongodump` and `age` commands must also be available on your `PATH`.

On Windows, install the two command-line tools before running a backup:

- **MongoDB Database Tools** (includes `mongodump` and `mongorestore`): download the Windows x86_64 ZIP from the
  [MongoDB Database Tools Download Center](https://www.mongodb.com/try/download/database-tools). Extract it and add its `bin` folder to your `PATH`.
  Open a new terminal and confirm the install with `mongodump --version`.
- **age**: install from PowerShell or Command Prompt with `winget install --id FiloSottile.age`. Open a new terminal and confirm it with
  `age --version`.

Copy `.env.example` to `.env` and fill in the values for your run. For a run with only the local destination, set `DESTINATIONS=local` and choose
`LOCAL_BACKUP_DIR`; R2 credentials are needed only when `DESTINATIONS` includes `r2`. The `backup:local` command loads `.env` when present, builds the
pipeline, and runs it. This command is the same in PowerShell, Command Prompt, and bash:

```text
pnpm install
pnpm run backup:local
```

`pnpm run backup` remains the CI-shaped command and does not load `.env`. Selecting `local` in GitHub Actions writes to temporary job storage; that
copy disappears when the job ends, so `local` is generally meaningless in CI.

Logs are structured JSON (pino), one object per line — greppable in CI and easy to ship elsewhere. Set `LOG_LEVEL` (default `info`) to adjust verbosity. For readable local output, pipe through pino-pretty:

```bash
pnpm run backup | pnpm dlx pino-pretty
```

## Verify a backup without restoring

```bash
aws s3 cp s3://mongodb-backups/backups/<OBJECT_KEY> backup.archive.gz.age \
  --endpoint-url <R2_ENDPOINT>

age -d -i key.txt -o dump.archive.gz backup.archive.gz.age
```

A successful `age -d` proves the archive decrypts with your key. The full download → verify → restore procedure lives in [docs/restore-checklist.md](docs/restore-checklist.md).

## Security model

- Client-side encryption before upload (age, X25519) — a compromise of R2 or the API token exposes ciphertext only.
- `MONGODB_URI` reaches `mongodump` through a temporary chmod-600 config file, deleted immediately after the dump: it never appears in process listings, command lines, or shell history. Logs go through pino with a destination that scrubs the URI from every line before it is written, and error messages are sanitized before they are thrown.
- Least privilege on every path: R2 token scoped to the single bucket; Atlas user limited to the backup role; workflow granted only `contents: read`.
- Dump artifacts are never uploaded as GitHub Actions artifacts; the temp workdir (which briefly holds the plaintext archive) is always removed.

## Caveats

- This repository is prepared but **not yet tested against your actual Atlas cluster or R2 account**. Run it manually, confirm the encrypted object appears in R2, and complete a test restore before relying on it.
- The 30-minute job timeout and 20-minute dump timeout assume a small/medium cluster; raise both for larger data sets.
- Retention is enforced by this pipeline. An R2 lifecycle rule on `backups/` makes a decent second line of defense.
- Dependencies are pinned by the committed `pnpm-lock.yaml`; CI installs with `--frozen-lockfile`, so every run builds against exactly what was verified locally. Update the lockfile with `pnpm install` after changing `package.json`, and commit it together.
- The temporary MongoDB URI file is protected with `chmod 600` on POSIX systems. Windows does not enforce those Unix permission bits through this call,
  so this protection is largely a no-op there; keep the local account and temporary folder private.
