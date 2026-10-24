/**
 * MongoDB Atlas → age-encrypted archive → Cloudflare R2, orchestrated in Node.js.
 *
 * Pipeline (each step must succeed, otherwise the process exits 1):
 *   1. mongodump  – steps/dump.ts   (URI via a chmod-600 config file, never a CLI arg)
 *   2. age        – steps/encrypt.ts (client-side encryption, public recipient key)
 *   3. AWS SDK v3 – storage/upload.ts (multipart upload + HeadObject verification)
 *   4. Retention  – storage/retention.ts (prune backups/ older than RETENTION_DAYS)
 *
 * Scheduled by .github/workflows/backup.yml (daily at 00:00 UTC + manual runs).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config/env.config.js";
import { mib, objectTimestamp } from "./lib/format.js";
import { logger, sanitize, setRedactionSecret } from "./logging.js";
import { runDump } from "./steps/dump.js";
import { encryptArchive } from "./steps/encrypt.js";
import { writeSummary } from "./summary.js";
import { assertToolInstalled } from "./tools.js";
import { buildS3Client } from "./storage/client.js";
import { pruneExpiredBackups } from "./storage/retention.js";
import { uploadAndVerify } from "./storage/upload.js";

async function main(): Promise<void> {
  const config = loadConfig();
  setRedactionSecret(config.MONGODB_URI);
  logger.level = config.LOG_LEVEL;

  const mongodumpVersion = await assertToolInstalled(config, "mongodump", ["--version"]);
  const ageVersion = await assertToolInstalled(config, "age", ["--version"]);
  logger.info({ mongodump: mongodumpVersion, age: ageVersion }, "toolchain ready");
  logger.info(
    {
      bucket: config.R2_BUCKET,
      prefix: config.BACKUP_PREFIX,
      retentionDays: config.RETENTION_DAYS,
    },
    "backup target",
  );

  const workDir = await mkdtemp(join(tmpdir(), "mongodb-backup-"));
  const client = buildS3Client(config);
  const objectKey = `${config.BACKUP_PREFIX}mongodb-${objectTimestamp()}.archive.gz.age`;

  try {
    const dump = await runDump(config, workDir);
    logger.info({ bytes: dump.bytes, human: mib(dump.bytes) }, "mongodump complete (gzipped archive)");

    const encrypted = await encryptArchive(config, dump.archivePath);
    logger.info({ bytes: encrypted.bytes, human: mib(encrypted.bytes) }, "archive encrypted with age");

    const uploaded = await uploadAndVerify(config, client, encrypted.encryptedPath, objectKey);
    logger.info(
      {
        bucket: config.R2_BUCKET,
        key: objectKey,
        bytes: uploaded.bytes,
        sha256: uploaded.sha256, // also stored as object metadata x-amz-meta-sha-256
      },
      "upload verified",
    );

    const deleted = await pruneExpiredBackups(config, client, objectKey);
    logger.info(
      { pruned: deleted.length, keys: deleted, retentionDays: config.RETENTION_DAYS },
      "retention policy applied",
    );

    await writeSummary([
      "### MongoDB backup summary",
      "",
      `- Object: \`s3://${config.R2_BUCKET}/${objectKey}\``,
      `- Encrypted size: ${uploaded.bytes} bytes`,
      `- SHA-256: \`${uploaded.sha256}\` (encrypted file, also in object metadata)`,
      `- Retention: ${deleted.length} object(s) pruned (${config.RETENTION_DAYS}-day policy)`,
    ]);
  } finally {
    // Workdir still holds the plaintext archive; always remove it.
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  // err.stack already contains the message, so prefer it and avoid duplication.
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  logger.error({ detail: sanitize(detail) }, "backup failed");
  process.exitCode = 1;
});
