import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { downloadAndDecryptArchive } from "../helpers/archive-helper.js";
import { runCli } from "../helpers/cli-runner.js";
import { getTestS3Client } from "../helpers/s3-test-config.js";

const execFileAsync = promisify(execFile);

describe("MongoDB multi-database discovery, blocklist filtering, and round-trip restore integration test", () => {
  const { s3Client, params: s3Params } = getTestS3Client();
  const mongodbUri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017";

  let mongoClient: MongoClient;
  let tempDir: string;
  const createdS3Keys: string[] = [];

  const SEED_TENANT_A_USERS = [
    { name: "Alice", email: "alice@tenant-a.com", active: true },
    { name: "Bob", email: "bob@tenant-a.com", active: false },
  ];

  const SEED_TENANT_A_SETTINGS = [{ key: "theme", value: "dark" }];

  const SEED_TENANT_B_ORDERS = [
    { orderId: "ORD-001", amount: 150.0, status: "completed" },
    { orderId: "ORD-002", amount: 89.95, status: "pending" },
  ];

  const SEED_ANALYTICS_EVENTS = [
    { event: "page_view", path: "/home", timestamp: 1700000000 },
    { event: "click", target: "buy-now", timestamp: 1700000001 },
  ];

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "mongo-integration-test-"));
    mongoClient = new MongoClient(mongodbUri);
    await mongoClient.connect();

    // Ensure test data exists and is clean
    await mongoClient.db("tenant_a").collection("users").deleteMany({});
    await mongoClient.db("tenant_a").collection("users").insertMany(SEED_TENANT_A_USERS);
    await mongoClient.db("tenant_a").collection("settings").deleteMany({});
    await mongoClient.db("tenant_a").collection("settings").insertMany(SEED_TENANT_A_SETTINGS);

    await mongoClient.db("tenant_b").collection("orders").deleteMany({});
    await mongoClient.db("tenant_b").collection("orders").insertMany(SEED_TENANT_B_ORDERS);

    await mongoClient.db("analytics_staging").collection("events").deleteMany({});
    await mongoClient.db("analytics_staging").collection("events").insertMany(SEED_ANALYTICS_EVENTS);
  }, 30000);

  afterAll(async () => {
    if (mongoClient) {
      await mongoClient
        .db("tenant_a_restored")
        .dropDatabase()
        .catch(() => undefined);
      await mongoClient
        .db("tenant_b_restored")
        .dropDatabase()
        .catch(() => undefined);
      await mongoClient.close().catch(() => undefined);
    }

    if (tempDir) {
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

  it("discovers databases, blocks analytics_staging, delivers tenant archives, and round-trip restores", async () => {
    const ageIdentity = await generateIdentity();
    const ageRecipient = await identityToRecipient(ageIdentity);
    const runId = Date.now();
    const backupPrefix = `backups/mongo-integration-${runId}/`;

    // 1. Execute production CLI with ENGINE=mongodb and MONGODB_DB_BLOCKLIST=analytics_staging
    const cliResult = await runCli({
      env: {
        ENGINE: "mongodb",
        MONGODB_URI: mongodbUri,
        MONGODB_DB_BLOCKLIST: "analytics_staging",
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
    const blocklistLogs = cliResult.findLogs("databases excluded by MONGODB_DB_BLOCKLIST");
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

    const tenantAKey = keys.find((key) => key.endsWith("tenant_a.archive.gz.age"));
    const tenantBKey = keys.find((key) => key.endsWith("tenant_b.archive.gz.age"));
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
      encryptedFileName: "tenant_a.archive.gz.age",
      decryptedFileName: "tenant_a.archive.gz",
      ageIdentity,
    });

    const tenantBDump = await downloadAndDecryptArchive({
      s3Client,
      bucket: s3Params.bucket,
      key: tenantBKey!,
      targetDir: tempDir,
      encryptedFileName: "tenant_b.archive.gz.age",
      decryptedFileName: "tenant_b.archive.gz",
      ageIdentity,
    });

    // 6. Restore unencrypted dumps into isolated target databases
    await execFileAsync("mongorestore", [
      `--uri=${mongodbUri}`,
      `--archive=${tenantADump}`,
      "--gzip",
      "--nsFrom=tenant_a.*",
      "--nsTo=tenant_a_restored.*",
      "--drop",
    ]);

    await execFileAsync("mongorestore", [
      `--uri=${mongodbUri}`,
      `--archive=${tenantBDump}`,
      "--gzip",
      "--nsFrom=tenant_b.*",
      "--nsTo=tenant_b_restored.*",
      "--drop",
    ]);

    // 7. Verify 100% document parity between source and restored data
    const originalUsers = await mongoClient.db("tenant_a").collection("users").find().sort({ name: 1 }).toArray();
    const restoredUsers = await mongoClient.db("tenant_a_restored").collection("users").find().sort({ name: 1 }).toArray();
    expect(restoredUsers).toEqual(originalUsers);

    const originalSettings = await mongoClient.db("tenant_a").collection("settings").find().toArray();
    const restoredSettings = await mongoClient.db("tenant_a_restored").collection("settings").find().toArray();
    expect(restoredSettings).toEqual(originalSettings);

    const originalOrders = await mongoClient.db("tenant_b").collection("orders").find().sort({ orderId: 1 }).toArray();
    const restoredOrders = await mongoClient.db("tenant_b_restored").collection("orders").find().sort({ orderId: 1 }).toArray();
    expect(restoredOrders).toEqual(originalOrders);
  }, 90000);
});
