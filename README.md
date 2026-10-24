# mongodb-backups

Daily, encrypted MongoDB Atlas backups pushed to Cloudflare R2 by a GitHub Actions workflow. A Node.js + TypeScript orchestrator runs the whole pipeline: `mongodump` creates the archive, `age` encrypts it, the AWS SDK for JavaScript v3 uploads it to R2 (no AWS CLI subprocess), and expired backups are pruned automatically.

**Keep this repository private.** The archive is encrypted client-side before it leaves the runner — R2 and anyone with access to the bucket only ever sees ciphertext.

## Architecture

```
GitHub Actions (cron 00:00 UTC = 05:00 PKT, or manual run)
└── Node.js orchestrator — src/main.ts (env validated with Valibot in src/config.ts)
    ├── mongodump (MongoDB Database Tools) → single gzipped archive, point-in-time via --oplog
    │     └── URI supplied via a chmod-600 temp config file — never a command-line argument
    ├── age encryption (recipient = AGE_RECIPIENT public key)
    ├── AWS SDK v3 → multipart upload to R2 → HeadObject verification (size must match)
    └── retention: delete backups/ objects older than RETENTION_DAYS
```

Objects land at `s3://<R2_BUCKET>/backups/mongodb-<YYYY-MM-DDTHHMMSSZ>.archive.gz.age`, each carrying its SHA-256 as `x-amz-meta-sha-256` metadata.

## Repository layout

```
mongodb-backups/
├── .github/workflows/backup.yml   # scheduler: daily 00:00 UTC + manual dispatch
├── src/
│   ├── main.ts                    # pipeline orchestration + top-level error handling
│   ├── config.ts                  # Valibot schema: validates all env vars in one pass
│   ├── constants.ts               # prefixes and timeouts
│   ├── logging.ts                 # log + fail + URI redaction
│   ├── summary.ts                 # GitHub Actions step summary writer
│   ├── tools.ts                   # mongodump/age preflight checks
│   ├── lib/
│   │   ├── exec.ts                # execFile wrapper + child-output extraction
│   │   ├── format.ts              # object keys, sizes
│   │   └── hash.ts                # SHA-256 of files
│   ├── steps/
│   │   ├── dump.ts                # mongodump → gzipped archive
│   │   └── encrypt.ts             # age encryption
│   └── storage/
│       ├── client.ts              # R2 S3Client factory
│       ├── upload.ts              # multipart upload + verification
│       └── retention.ts           # prune objects older than RETENTION_DAYS
├── docs/restore-checklist.md      # do this once against a scratch cluster
├── .env.example                   # local-run template (gitignored as .env)
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

## One-time setup

1. **Repository** — create the *private* repo `mongodb-backups` and push these files.
2. **age keys** — install [age](https://github.com/FiloSottile/age), then `age-keygen -o key.txt`:
   - the `# public key: age1...` line → GitHub secret `AGE_RECIPIENT`
   - the `AGE-SECRET-KEY-1...` private line → store offline (password manager / offline media). **If you lose it, every backup is unrecoverable.** Never commit it.
3. **R2** — create the bucket `mongodb-backups`; then R2 → Manage R2 API Tokens → Create API Token → permission *Object Read & Write*, scope *apply to specific bucket only* → `mongodb-backups`. Note the Access Key ID and Secret Access Key.
4. **GitHub secrets** (Settings → Secrets and variables → Actions → *Secrets*): `MONGODB_URI`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `AGE_RECIPIENT`. The Account ID is on the R2 overview page.
5. **GitHub variables** (same page → *Variables*): `R2_BUCKET` = `mongodb-backups`. Optional: `RETENTION_DAYS` (default 30).
6. **Atlas** — dedicated backup user with the built-in `backup` role. Network Access: GitHub-hosted runners use rotating IPs, so either allow `0.0.0.0/0` (acceptable here because the user is limited to the backup role and the SRV string is SCRAM-protected) or self-host a runner with a static IP you can allowlist. Take the SRV connection string for that user → secret `MONGODB_URI`.
7. **First run** — Actions → **MongoDB Atlas Backup** → Run workflow.

## Running

- **Manual**: Actions → MongoDB Atlas Backup → Run workflow.
- **Scheduled**: daily at 00:00 UTC (05:00 Pakistan time). Midnight UTC is a busy time for GitHub's schedulers, so runs may start several minutes late — but it still fires once per day.
- **Failure behavior**: any failed step fails the job loudly; nothing is uploaded unless encryption and dump both succeeded. Each successful run's step summary lists the object key, encrypted size, SHA-256, and pruned objects.
- GitHub disables scheduled workflows after **60 days of repository inactivity** — any commit re-enables it. Watch for the notification email.

## Local run

Requires Node 20+, [pnpm](https://pnpm.io/installation) (or `corepack enable`, which reads the pinned version from `package.json`), plus `mongodump` and `age` on your PATH.

```bash
cp .env.example .env   # fill in values
pnpm install
set -a; source .env; set +a
pnpm run backup
```

(`.env` is not auto-loaded — the `set -a` snippet exports it for the current shell.)

Logs are structured JSON (pino), one object per line — greppable in CI and easy to ship elsewhere. Set `LOG_LEVEL` (default `info`) to adjust verbosity. For readable local output, pipe through pino-pretty:

```bash
pnpm run backup | pnpm dlx pino-pretty
```

## Verify a backup without restoring

```bash
aws s3 cp s3://mongodb-backups/backups/<OBJECT_KEY> backup.archive.gz.age \
  --endpoint-url https://<ACCOUNT_ID>.r2.cloudflarestorage.com

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
