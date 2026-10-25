import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config/env.config.js";
import { deliverArchive, failedOutcomes } from "./destinations/deliver.js";
import { buildDestinations } from "./destinations/index.js";
import { archiveObjectKey, mib } from "./lib/format.js";
import { splitPostgresUri } from "./lib/postgres.js";
import { fail, logger, sanitize, setRedactionSecrets } from "./logging.js";
import { runDump } from "./steps/dump.js";
import { encryptArchive } from "./steps/encrypt.js";
import { renderSummary, writeSummary } from "./summary.js";
import { assertPreflightTools } from "./tools.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.ENGINE === "mongodb") {
    setRedactionSecrets([{ name: "MONGODB_URI", value: config.MONGODB_URI }]);
  } else {
    const { password } = splitPostgresUri(config.POSTGRESQL_URI);
    setRedactionSecrets([
      { name: "POSTGRESQL_URI", value: config.POSTGRESQL_URI },
      ...(password ? [{ name: "POSTGRESQL_PASSWORD", value: password }] : []),
    ]);
  }
  logger.level = config.LOG_LEVEL;

  const destinations = buildDestinations(config);
  const tools = await assertPreflightTools(config);
  logger.info(tools, "toolchain ready");
  logger.info(
    {
      destinations: destinations.map((destination) => destination.id),
      prefix: config.BACKUP_PREFIX,
      retentionDays: config.RETENTION_DAYS,
    },
    "backup targets",
  );

  const workDir = await mkdtemp(join(tmpdir(), `${config.ENGINE}-backup-`));
  const objectKey = archiveObjectKey(config.BACKUP_PREFIX, config.ENGINE, new Date());

  try {
    const dump = await runDump(config, workDir);
    const dumpMsg = config.ENGINE === "mongodb" ? "mongodump complete (gzipped archive)" : "pg_dump complete (custom archive)";
    logger.info({ bytes: dump.bytes, human: mib(dump.bytes) }, dumpMsg);

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
