import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config/env.config.js";
import { deliverArchive, failedOutcomes } from "./destinations/deliver.js";
import { buildDestinations } from "./destinations/index.js";
import { archiveObjectKey, mib } from "./lib/format.js";
import { fail, logger, sanitize, setRedactionSecret } from "./logging.js";
import { runDump } from "./steps/dump.js";
import { encryptArchive } from "./steps/encrypt.js";
import { renderSummary, writeSummary } from "./summary.js";
import { assertToolInstalled } from "./tools.js";

async function main(): Promise<void> {
  const config = loadConfig();
  setRedactionSecret(config.MONGODB_URI);
  logger.level = config.LOG_LEVEL;

  const destinations = buildDestinations(config);
  const mongodumpVersion = await assertToolInstalled(config, "mongodump", ["--version"]);
  logger.info({ mongodump: mongodumpVersion }, "toolchain ready");
  logger.info(
    {
      destinations: destinations.map((destination) => destination.id),
      prefix: config.BACKUP_PREFIX,
      retentionDays: config.RETENTION_DAYS,
    },
    "backup targets",
  );

  const workDir = await mkdtemp(join(tmpdir(), "mongodb-backup-"));
  const objectKey = archiveObjectKey(config.BACKUP_PREFIX, new Date());

  try {
    const dump = await runDump(config, workDir);
    logger.info({ bytes: dump.bytes, human: mib(dump.bytes) }, "mongodump complete (gzipped archive)");

    const encrypted = await encryptArchive(config, dump.archivePath);
    logger.info({ bytes: encrypted.bytes, human: mib(encrypted.bytes) }, "archive encrypted with age");

    const outcomes = await deliverArchive(destinations, encrypted.encryptedPath, objectKey);
    await writeSummary(renderSummary(outcomes, config.RETENTION_DAYS, objectKey));

    const failed = failedOutcomes(outcomes);
    if (failed.length > 0) {
      const details = failed.map((outcome) => `${outcome.id} (${outcome.failure.stage}): ${outcome.failure.message}`).join("; ");
      fail(`One or more destinations failed: ${details}`);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  logger.error({ detail: sanitize(detail) }, "backup failed");
  process.exitCode = 1;
});
