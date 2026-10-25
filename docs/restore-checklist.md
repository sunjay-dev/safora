# Restore checklist

Work through this end-to-end **once, against a scratch cluster, before you actually need a backup.** A backup that has never been restored is a hope, not a backup.

## What you need

- `age` and the **private key** (`key.txt`, the `AGE-SECRET-KEY-1...` line). The public key in `AGE_RECIPIENT` cannot decrypt.
- MongoDB Database Tools (`mongorestore`).
- R2 credentials with Object Read (the same bucket-scoped token works), the R2 endpoint URL (same value as your `R2_ENDPOINT` secret, e.g. `https://<account>.r2.cloudflarestorage.com`), and the AWS CLI — or download the object from the Cloudflare dashboard, or use rclone (config below).

## 1. Find the backup

The run's step summary (GitHub → Actions → the run) lists the object key and SHA-256. To list everything instead:

```bash
aws s3 ls s3://mongodb-backups/backups/ \
  --endpoint-url <R2_ENDPOINT>
```

For a local destination, locate the archive in `LOCAL_BACKUP_DIR` by its object key. The local
archive uses the same object key as the R2 archive.

## 2. Download, verify, decrypt

```bash
export AWS_ACCESS_KEY_ID=<R2 access key id>
export AWS_SECRET_ACCESS_KEY=<R2 secret access key>

aws s3 cp s3://mongodb-backups/backups/<OBJECT_KEY> ./backup.archive.gz.age \
  --endpoint-url <R2_ENDPOINT>

# Integrity check — this hash is of the ENCRYPTED file, and matches both the
# run's step summary and the object's x-amz-meta-sha-256 metadata.
sha256sum backup.archive.gz.age

age -d -i key.txt -o dump.archive.gz backup.archive.gz.age
```

`age -d` succeeding is itself proof the archive decrypts with your key.

When restoring from `LOCAL_BACKUP_DIR`, skip the R2 download and use the local archive file as
input to the integrity check and decryption. For example:

```bash
sha256sum "$LOCAL_BACKUP_DIR/<OBJECT_KEY>"
age -d -i key.txt -o dump.archive.gz "$LOCAL_BACKUP_DIR/<OBJECT_KEY>"
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

```bash
# Validate the archive without writing anything
mongorestore --uri "mongodb+srv://<scratch-cluster>" --archive=dump.archive.gz --gzip --oplogReplay --dryRun

# Real restore (add --drop if restoring over an existing copy of the data)
mongorestore --uri "mongodb+srv://<scratch-cluster>" --archive=dump.archive.gz --gzip --oplogReplay
```

Notes:

- Dumps are taken with `--oplog`, so `--oplogReplay` restores to a consistent point in time rather than the ragged state of "whenever each collection happened to finish".
- Restoring to the production cluster is the same command with the production URI — only after the scratch restore checks out.

## 4. Sanity checks

- Document counts on your critical collections match expectations.
- Application read-path smoke test against the scratch cluster.
- Write down how long the whole procedure took — that is your real recovery time, not an estimate.

## 5. Key escrow

- Losing `key.txt` makes **every existing backup permanently unreadable**. Keep an offline copy (password manager + physical/offline medium).
- To rotate keys: generate a new pair, update the `AGE_RECIPIENT` secret, keep the old private key until all backups made with it have aged out of retention. Stored backups are not re-encrypted automatically.
