import { chmod, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config, MongodbConfig, PostgresConfig } from "../config/env.config.js";
import { execDetail, execFileAsync, type ExecFileFn } from "../lib/exec.js";
import {
  ENUMERATE_DATABASES_QUERY,
  buildDatabaseConnectionArgs,
  buildPgDumpArgs,
  buildPgRestoreArgs,
  buildPsqlArgs,
  parseDatabaseList,
  splitPostgresUri,
  withPgpassFile,
} from "../lib/postgres.js";
import { fail } from "../logging.js";

/** Full-cluster MongoDB dump to a single gzipped archive; URI supplied via a private config file. */
export async function runMongodbDump(
  config: MongodbConfig,
  workDir: string,
  exec: ExecFileFn = execFileAsync,
): Promise<{ archivePath: string; bytes: number }> {
  const dumpConfigPath = join(workDir, "mongodump.conf");
  await writeFile(dumpConfigPath, `${JSON.stringify({ uri: config.MONGODB_URI })}\n`, {
    mode: 0o600,
  });
  await chmod(dumpConfigPath, 0o600);

  const archivePath = join(workDir, "dump.archive.gz");
  try {
    await exec("mongodump", ["--config", dumpConfigPath, `--archive=${archivePath}`, "--gzip", "--oplog"], {
      timeout: config.DUMP_TIMEOUT_MS,
      maxBuffer: config.MAX_BUFFER,
    });
  } catch (err) {
    fail(`mongodump failed:\n${execDetail(err)}`);
  } finally {
    await rm(dumpConfigPath, { force: true });
  }

  const bytes = (await stat(archivePath)).size;
  if (bytes === 0) {
    fail("mongodump reported success but produced an empty archive.");
  }
  return { archivePath, bytes };
}

/** Validates a custom-format PostgreSQL archive using `pg_restore --list`. Fails if output is empty. */
export async function verifyPostgresArchive(
  archivePath: string,
  timeoutMs: number,
  maxBuffer: number,
  exec: ExecFileFn = execFileAsync,
): Promise<string> {
  let stdout: string;
  try {
    const result = await exec("pg_restore", buildPgRestoreArgs(archivePath), {
      timeout: timeoutMs,
      maxBuffer,
    });
    stdout = result.stdout ?? "";
  } catch (err) {
    fail(`pg_restore --list failed:\n${execDetail(err)}`);
  }

  if (stdout.trim() === "") {
    fail("pg_restore --list reported success but produced empty output.");
  }
  return stdout;
}

/**
 * Enumerates all non-template, connectable databases on the PostgreSQL server via `psql`.
 * Fails loudly if zero databases are returned.
 */
export async function enumeratePostgresDatabases(config: PostgresConfig, pgpassPath?: string, exec: ExecFileFn = execFileAsync): Promise<string[]> {
  const { connectionArgs } = splitPostgresUri(config.POSTGRESQL_URI);
  const args = buildPsqlArgs(connectionArgs, ENUMERATE_DATABASES_QUERY);

  let stdout: string;
  try {
    const result = await exec("psql", args, {
      timeout: config.DUMP_TIMEOUT_MS,
      maxBuffer: config.MAX_BUFFER,
      env: pgpassPath ? { ...process.env, PGPASSFILE: pgpassPath } : process.env,
    });
    stdout = result.stdout ?? "";
  } catch (err) {
    fail(`psql database enumeration failed:\n${execDetail(err)}`);
  }

  const databases = parseDatabaseList(stdout);
  if (databases.length === 0) {
    fail("no databases to back up");
  }

  return databases;
}

/** PostgreSQL dump for a specific database using custom format into the temp workspace, validated with `pg_restore --list`. */
export async function runPostgresDump(
  config: PostgresConfig,
  workDir: string,
  database: string,
  pgpassPathOrExec?: string | ExecFileFn,
  maybeExec?: ExecFileFn,
): Promise<{ archivePath: string; bytes: number }> {
  const pgpassPath = typeof pgpassPathOrExec === "string" ? pgpassPathOrExec : undefined;
  const exec = typeof pgpassPathOrExec === "function" ? pgpassPathOrExec : (maybeExec ?? execFileAsync);

  const { strippedUri, pgpassEntry } = splitPostgresUri(config.POSTGRESQL_URI);
  const connectionArgs = buildDatabaseConnectionArgs(strippedUri, database);
  const archivePath = join(workDir, `postgres-${database}.dump`);
  const dumpArgs = buildPgDumpArgs(connectionArgs, archivePath);

  const doDump = async (activePgpassPath: string | undefined) => {
    try {
      await exec("pg_dump", dumpArgs, {
        timeout: config.DUMP_TIMEOUT_MS,
        maxBuffer: config.MAX_BUFFER,
        env: activePgpassPath ? { ...process.env, PGPASSFILE: activePgpassPath } : process.env,
      });
    } catch (err) {
      fail(`pg_dump failed:\n${execDetail(err)}`);
    }

    const bytes = (await stat(archivePath)).size;
    if (bytes === 0) {
      fail("pg_dump reported success but produced an empty archive.");
    }

    await verifyPostgresArchive(archivePath, config.DUMP_TIMEOUT_MS, config.MAX_BUFFER, exec);

    return { archivePath, bytes };
  };

  if (pgpassPath !== undefined) {
    return doDump(pgpassPath);
  }
  return withPgpassFile(workDir, pgpassEntry, doDump);
}

/** Dump step branching on the selected engine — mongodb or postgres. */
export async function runDump(config: Config, workDir: string, exec: ExecFileFn = execFileAsync): Promise<{ archivePath: string; bytes: number }> {
  switch (config.ENGINE) {
    case "mongodb":
      return runMongodbDump(config, workDir, exec);
    case "postgres":
      fail("PostgreSQL engine backs up multiple databases; use runPostgresBackup");
  }
}
