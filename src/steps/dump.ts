import { chmod, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config, MongodbConfig, PostgresConfig } from "../config/env.config.js";
import { execDetail, execFileAsync, type ExecFileFn } from "../lib/exec.js";
import { buildPgDumpArgs, buildPgRestoreArgs, splitPostgresUri, withPgpassFile } from "../lib/postgres.js";
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

/** PostgreSQL dump using custom format into the temp workspace, validated with `pg_restore --list`. */
export async function runPostgresDump(
  config: PostgresConfig,
  workDir: string,
  exec: ExecFileFn = execFileAsync,
): Promise<{ archivePath: string; bytes: number }> {
  const { connectionArgs, pgpassEntry } = splitPostgresUri(config.POSTGRESQL_URI);
  const archivePath = join(workDir, "postgres.dump");
  const dumpArgs = buildPgDumpArgs(connectionArgs, archivePath);

  return withPgpassFile(workDir, pgpassEntry, async (pgpassPath) => {
    try {
      await exec("pg_dump", dumpArgs, {
        timeout: config.DUMP_TIMEOUT_MS,
        maxBuffer: config.MAX_BUFFER,
        env: pgpassPath ? { ...process.env, PGPASSFILE: pgpassPath } : process.env,
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
  });
}

/** Dump step branching on the selected engine \u2014 mongodb or postgres. */
export async function runDump(config: Config, workDir: string, exec: ExecFileFn = execFileAsync): Promise<{ archivePath: string; bytes: number }> {
  switch (config.ENGINE) {
    case "mongodb":
      return runMongodbDump(config, workDir, exec);
    case "postgres":
      return runPostgresDump(config, workDir, exec);
  }
}
