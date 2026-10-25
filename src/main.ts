import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type MongodbConfig, type PostgresConfig } from "./config/env.config.js";
import { deliverArchive, failedOutcomes } from "./destinations/deliver.js";
import type { Destination } from "./destinations/destination.js";
import { buildDestinations } from "./destinations/index.js";
import { execFileAsync, type ExecFileFn } from "./lib/exec.js";
import { archiveObjectKey, mib } from "./lib/format.js";
import { splitPostgresUri, withPgpassFile } from "./lib/postgres.js";
import { fail, logger, sanitize, setRedactionSecrets } from "./logging.js";
import { enumeratePostgresDatabases, runMongodbDump, runPostgresDump } from "./steps/dump.js";
import { encryptArchive } from "./steps/encrypt.js";
import { renderSummary, writeSummary } from "./summary.js";
import { assertPreflightTools } from "./tools.js";

export interface BackupExecutionOptions {
  now?: Date;
  exec?: ExecFileFn;
  encrypt?: typeof encryptArchive;
  deliver?: typeof deliverArchive;
  writeSummary?: typeof writeSummary;
}

/** Runs the backup flow for MongoDB: dumps the cluster to a single archive, encrypts, and delivers. */
export async function runMongodbBackup(
  config: MongodbConfig,
  destinations: readonly Destination[],
  workDir: string,
  options: BackupExecutionOptions = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const exec = options.exec ?? execFileAsync;
  const encrypt = options.encrypt ?? encryptArchive;
  const deliver = options.deliver ?? deliverArchive;
  const writeSum = options.writeSummary ?? writeSummary;

  const objectKey = archiveObjectKey(config.BACKUP_PREFIX, "mongodb", now);
  const dump = await runMongodbDump(config, workDir, exec);
  logger.info({ bytes: dump.bytes, human: mib(dump.bytes) }, "mongodump complete (gzipped archive)");

  const encrypted = await encrypt(config, dump.archivePath);
  logger.info({ bytes: encrypted.bytes, human: mib(encrypted.bytes) }, "archive encrypted with age");

  const outcomes = await deliver(destinations, encrypted.encryptedPath, objectKey);
  await writeSum(renderSummary(outcomes, config.RETENTION_DAYS, objectKey));

  const failed = failedOutcomes(outcomes);
  if (failed.length > 0) {
    const details = failed.map((outcome) => `${outcome.id} (${outcome.failure.stage}): ${outcome.failure.message}`).join("; ");
    fail(`One or more destinations failed: ${details}`);
  }
}

/**
 * Runs the backup flow for PostgreSQL: enumerates all non-template databases via psql,
 * then for each database runs dump, verify, encrypt, deliver, and retention.
 * Attempts all databases, collects failures, and fails the run if any database fails.
 */
export async function runPostgresBackup(
  config: PostgresConfig,
  destinations: readonly Destination[],
  workDir: string,
  options: BackupExecutionOptions = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const exec = options.exec ?? execFileAsync;
  const encrypt = options.encrypt ?? encryptArchive;
  const deliver = options.deliver ?? deliverArchive;
  const writeSum = options.writeSummary ?? writeSummary;

  const { pgpassEntry } = splitPostgresUri(config.POSTGRESQL_URI);

  await withPgpassFile(workDir, pgpassEntry, async (pgpassPath) => {
    const databases = await enumeratePostgresDatabases(config, pgpassPath, exec);
    logger.info({ databases, count: databases.length }, "enumerated postgres databases");

    const failures: Array<{ database: string; error: unknown }> = [];

    for (const database of databases) {
      const objectKey = archiveObjectKey(config.BACKUP_PREFIX, "postgres", now, database);
      try {
        const dump = await runPostgresDump(config, workDir, database, pgpassPath, exec);
        logger.info({ database, bytes: dump.bytes, human: mib(dump.bytes) }, "pg_dump complete (custom archive)");

        const encrypted = await encrypt(config, dump.archivePath);
        logger.info({ database, bytes: encrypted.bytes, human: mib(encrypted.bytes) }, "archive encrypted with age");

        const outcomes = await deliver(destinations, encrypted.encryptedPath, objectKey);
        await writeSum(renderSummary(outcomes, config.RETENTION_DAYS, objectKey, `### PostgreSQL backup summary (${database})`));

        // Clean up temporary files for this database
        await rm(dump.archivePath, { force: true }).catch(() => undefined);
        await rm(encrypted.encryptedPath, { force: true }).catch(() => undefined);

        const failed = failedOutcomes(outcomes);
        if (failed.length > 0) {
          const details = failed.map((outcome) => `${outcome.id} (${outcome.failure.stage}): ${outcome.failure.message}`).join("; ");
          failures.push({ database, error: new Error(`One or more destinations failed: ${details}`) });
        }
      } catch (err) {
        logger.error({ database, detail: sanitize(err instanceof Error ? (err.stack ?? err.message) : String(err)) }, "database backup failed");
        failures.push({ database, error: err });
      }
    }

    if (failures.length > 0) {
      const details = failures.map((f) => `${f.database}: ${f.error instanceof Error ? f.error.message : String(f.error)}`).join("; ");
      fail(`One or more databases failed to back up: ${details}`);
    }
  });
}

export async function main(): Promise<void> {
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
  const now = new Date();

  try {
    if (config.ENGINE === "mongodb") {
      await runMongodbBackup(config, destinations, workDir, { now });
    } else {
      await runPostgresBackup(config, destinations, workDir, { now });
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

if (typeof require !== "undefined" && require.main === module) {
  main().catch((err: unknown) => {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    logger.error({ detail: sanitize(detail) }, "backup failed");
    process.exitCode = 1;
  });
}
