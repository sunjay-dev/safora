import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { Decrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.config.js";
import { buildDatabaseUri, splitPostgresUri, withPgpassFile } from "../../src/lib/postgres.js";
import { buildS3Client } from "../../src/storage/client.js";
import { runCli } from "../helpers/cli-runner.js";

const execFileAsync = promisify(execFile);

describe("PostgreSQL multi-database discovery, blocklist filtering, and round-trip restore integration test", () => {
  const endpoint = process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000";
  const bucket = process.env.S3_BUCKET ?? "test-bucket";
  const region = process.env.S3_REGION ?? "us-east-1";
  const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? "minioadmin";
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin";
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE ?? "true";
  const postgresUri = process.env.POSTGRESQL_URI ?? "postgresql://postgres:postgres@127.0.0.1:5433/postgres";

  const s3Config = loadConfig({
    DESTINATIONS: "s3",
    ENGINE: "postgres",
    POSTGRESQL_URI: postgresUri,
    AGE_RECIPIENT: "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p",
    S3_ENDPOINT: endpoint,
    S3_BUCKET: bucket,
    S3_REGION: region,
    S3_ACCESS_KEY_ID: accessKeyId,
    S3_SECRET_ACCESS_KEY: secretAccessKey,
    S3_FORCE_PATH_STYLE: forcePathStyle,
  });

  const s3Client = buildS3Client(s3Config);
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
            Bucket: bucket,
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
        S3_ENDPOINT: endpoint,
        S3_BUCKET: bucket,
        S3_REGION: region,
        S3_ACCESS_KEY_ID: accessKeyId,
        S3_SECRET_ACCESS_KEY: secretAccessKey,
        S3_FORCE_PATH_STYLE: forcePathStyle,
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
        Bucket: bucket,
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

    // 5. Download and decrypt archives using age test key
    async function downloadAndDecrypt(key: string, baseName: string): Promise<string> {
      const encryptedPath = join(tempDir, `${baseName}.dump.age`);
      const decryptedPath = join(tempDir, `${baseName}.dump`);

      const getRes = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const encryptedStream = getRes.Body as Readable;
      await pipeline(encryptedStream, createWriteStream(encryptedPath));

      const decrypter = new Decrypter();
      decrypter.addIdentity(ageIdentity);
      const inputStream = Readable.toWeb(createReadStream(encryptedPath)) as ReadableStream<Uint8Array>;
      const decryptedStream = await decrypter.decrypt(inputStream);
      await pipeline(decryptedStream, createWriteStream(decryptedPath));

      return decryptedPath;
    }

    const tenantADecrypted = await downloadAndDecrypt(tenantAKey!, "tenant_a");
    const tenantBDecrypted = await downloadAndDecrypt(tenantBKey!, "tenant_b");

    // 6. Create target restore databases
    await executePsql("postgres", "CREATE DATABASE tenant_a_restored;");
    await executePsql("postgres", "CREATE DATABASE tenant_b_restored;");

    // 7. Restore unencrypted archives using pg_restore
    await withPgpassFile(tempDir, pgpassEntry, async (pgpassPath) => {
      const tenantARestoredUri = buildDatabaseUri(strippedUri, "tenant_a_restored");
      const tenantBRestoredUri = buildDatabaseUri(strippedUri, "tenant_b_restored");
      const env = pgpassPath ? { ...process.env, PGPASSFILE: pgpassPath } : process.env;

      await execFileAsync("pg_restore", ["--dbname", tenantARestoredUri, tenantADecrypted], { env });
      await execFileAsync("pg_restore", ["--dbname", tenantBRestoredUri, tenantBDecrypted], { env });
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
