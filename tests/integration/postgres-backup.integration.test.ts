import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDatabaseUri, splitPostgresUri, withPgpassFile } from "../../src/lib/postgres.js";
import { downloadAndDecryptArchive } from "../helpers/archive-helper.js";
import { runCli } from "../helpers/cli-runner.js";
import { getTestS3Client } from "../helpers/s3-test-config.js";

const execFileAsync = promisify(execFile);

describe("PostgreSQL multi-database discovery, blocklist filtering, and round-trip restore integration test", () => {
  const { s3Client, params: s3Params } = getTestS3Client();
  const postgresUri = process.env.POSTGRESQL_URI ?? "postgresql://postgres:postgres@127.0.0.1:5433/postgres";

  let tempDir: string;
  const createdS3Keys: string[] = [];

  const { strippedUri, pgpassEntry } = splitPostgresUri(postgresUri);

  async function queryJson(database: string, query: string): Promise<unknown> {
    return withPgpassFile(tempDir, pgpassEntry, async (pgpassPath) => {
      const dbUri = buildDatabaseUri(strippedUri, database);
      const env = pgpassPath ? { ...process.env, PGPASSFILE: pgpassPath } : process.env;
      const { stdout } = await execFileAsync("psql", [dbUri, "--no-align", "--tuples-only", "--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-c", query], {
        env,
      });
      const trimmed = stdout.trim();
      if (!trimmed) {
        return null;
      }
      return JSON.parse(trimmed);
    });
  }

  async function executePsql(database: string, statement: string): Promise<void> {
    await withPgpassFile(tempDir, pgpassEntry, async (pgpassPath) => {
      const dbUri = buildDatabaseUri(strippedUri, database);
      const env = pgpassPath ? { ...process.env, PGPASSFILE: pgpassPath } : process.env;
      await execFileAsync("psql", [dbUri, "--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-c", statement], { env });
    });
  }

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pg-integration-test-"));

    // Drop any existing restored databases from previous runs
    await executePsql("postgres", "DROP DATABASE IF EXISTS tenant_a_restored;").catch(() => undefined);
    await executePsql("postgres", "DROP DATABASE IF EXISTS tenant_b_restored;").catch(() => undefined);
  });

  afterAll(async () => {
    if (tempDir) {
      await executePsql("postgres", "DROP DATABASE IF EXISTS tenant_a_restored;").catch(() => undefined);
      await executePsql("postgres", "DROP DATABASE IF EXISTS tenant_b_restored;").catch(() => undefined);
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }

    if (createdS3Keys.length > 0) {
      await s3Client
        .send(
          new DeleteObjectsCommand({
            Bucket: s3Params.bucket,
            Delete: { Objects: createdS3Keys.map((Key) => ({ Key })) },
          }),
        )
        .catch(() => undefined);
    }
  });

  it("discovers databases, blocks analytics_staging, delivers tenant archives, and round-trip restores via pg_restore", async () => {
    const ageIdentity = await generateIdentity();
    const ageRecipient = await identityToRecipient(ageIdentity);
    const runId = Date.now();
    const backupPrefix = `backups/postgres-integration-${runId}/`;

    // 1. Execute production CLI with ENGINE=postgres and PG_DB_BLOCKLIST=analytics_staging
    const cliResult = await runCli({
      env: {
        ENGINE: "postgres",
        POSTGRESQL_URI: postgresUri,
        PG_DB_BLOCKLIST: "analytics_staging",
        DESTINATIONS: "s3",
        AGE_RECIPIENT: ageRecipient,
        S3_ENDPOINT: s3Params.endpoint,
        S3_BUCKET: s3Params.bucket,
        S3_REGION: s3Params.region,
        S3_ACCESS_KEY_ID: s3Params.accessKeyId,
        S3_SECRET_ACCESS_KEY: s3Params.secretAccessKey,
        S3_FORCE_PATH_STYLE: s3Params.forcePathStyle,
        BACKUP_PREFIX: backupPrefix,
        RETENTION_DAYS: "14",
      },
      timeoutMs: 60000,
    });

    // 2. Validate clean exit code
    expect(cliResult.exitCode, `CLI failed with logs: ${cliResult.stdout}\n${cliResult.stderr}`).toBe(0);

    // 3. Validate structured log emissions
    const blocklistLogs = cliResult.findLogs("databases excluded by PG_DB_BLOCKLIST");
    expect(blocklistLogs.length).toBeGreaterThan(0);
    expect(blocklistLogs[0].blocked).toContain("analytics_staging");

    const selectedLogs = cliResult.findLogs("databases selected for backup");
    expect(selectedLogs.length).toBeGreaterThan(0);
    const selectedDbs = selectedLogs[0].databases as string[];
    expect(selectedDbs).toContain("tenant_a");
    expect(selectedDbs).toContain("tenant_b");
    expect(selectedDbs).not.toContain("analytics_staging");

    // 4. Validate delivered objects in S3
    const listRes = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: s3Params.bucket,
        Prefix: backupPrefix,
      }),
    );

    const objects = listRes.Contents ?? [];
    const keys = objects.map((obj) => obj.Key!).filter(Boolean);
    createdS3Keys.push(...keys);

    const tenantAKey = keys.find((key) => key.endsWith("tenant_a.dump.age"));
    const tenantBKey = keys.find((key) => key.endsWith("tenant_b.dump.age"));
    const analyticsKey = keys.find((key) => key.includes("analytics_staging"));

    expect(tenantAKey).toBeDefined();
    expect(tenantBKey).toBeDefined();
    expect(analyticsKey).toBeUndefined();

    // 5. Download and decrypt archives using age test key to plain dumps
    const tenantADump = await downloadAndDecryptArchive({
      s3Client,
      bucket: s3Params.bucket,
      key: tenantAKey!,
      targetDir: tempDir,
      encryptedFileName: "tenant_a.dump.age",
      decryptedFileName: "tenant_a.dump",
      ageIdentity,
    });

    const tenantBDump = await downloadAndDecryptArchive({
      s3Client,
      bucket: s3Params.bucket,
      key: tenantBKey!,
      targetDir: tempDir,
      encryptedFileName: "tenant_b.dump.age",
      decryptedFileName: "tenant_b.dump",
      ageIdentity,
    });

    // 6. Create target restore databases
    await executePsql("postgres", "CREATE DATABASE tenant_a_restored;");
    await executePsql("postgres", "CREATE DATABASE tenant_b_restored;");

    // 7. Restore unencrypted dumps using pg_restore
    await withPgpassFile(tempDir, pgpassEntry, async (pgpassPath) => {
      const tenantARestoredUri = buildDatabaseUri(strippedUri, "tenant_a_restored");
      const tenantBRestoredUri = buildDatabaseUri(strippedUri, "tenant_b_restored");
      const env = pgpassPath ? { ...process.env, PGPASSFILE: pgpassPath } : process.env;

      await execFileAsync("pg_restore", ["--dbname", tenantARestoredUri, tenantADump], { env });
      await execFileAsync("pg_restore", ["--dbname", tenantBRestoredUri, tenantBDump], { env });
    });

    // 8. Verify 100% table and row parity between source and restored data
    const originalUsers = await queryJson("tenant_a", "SELECT json_agg(t) FROM (SELECT name, email, active FROM users ORDER BY name) t;");
    const restoredUsers = await queryJson("tenant_a_restored", "SELECT json_agg(t) FROM (SELECT name, email, active FROM users ORDER BY name) t;");
    expect(restoredUsers).toEqual(originalUsers);

    const originalSettings = await queryJson("tenant_a", "SELECT json_agg(t) FROM (SELECT key, value FROM settings ORDER BY key) t;");
    const restoredSettings = await queryJson("tenant_a_restored", "SELECT json_agg(t) FROM (SELECT key, value FROM settings ORDER BY key) t;");
    expect(restoredSettings).toEqual(originalSettings);

    const originalOrders = await queryJson("tenant_b", "SELECT json_agg(t) FROM (SELECT order_id, amount, status FROM orders ORDER BY order_id) t;");
    const restoredOrders = await queryJson(
      "tenant_b_restored",
      "SELECT json_agg(t) FROM (SELECT order_id, amount, status FROM orders ORDER BY order_id) t;",
    );
    expect(restoredOrders).toEqual(originalOrders);
  }, 90000);
});
