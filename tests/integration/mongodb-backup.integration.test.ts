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
import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.config.js";
import { buildS3Client } from "../../src/storage/client.js";
import { runCli } from "../helpers/cli-runner.js";

const execFileAsync = promisify(execFile);

describe("MongoDB multi-database discovery, blocklist filtering, and round-trip restore integration test", () => {
  const endpoint = process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000";
  const bucket = process.env.S3_BUCKET ?? "test-bucket";
  const region = process.env.S3_REGION ?? "us-east-1";
  const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? "minioadmin";
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin";
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE ?? "true";
  const mongodbUri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017";

  const s3Config = loadConfig({
    DESTINATIONS: "s3",
    ENGINE: "postgres",
    POSTGRESQL_URI: "postgresql://postgres:postgres@localhost:5433/postgres",
    AGE_RECIPIENT: "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p",
    S3_ENDPOINT: endpoint,
    S3_BUCKET: bucket,
    S3_REGION: region,
    S3_ACCESS_KEY_ID: accessKeyId,
    S3_SECRET_ACCESS_KEY: secretAccessKey,
    S3_FORCE_PATH_STYLE: forcePathStyle,
  });

  const s3Client = buildS3Client(s3Config);
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
            Bucket: bucket,
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
        Bucket: bucket,
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

    // 5. Download and decrypt archives using age test key
    async function downloadAndDecrypt(key: string, baseName: string): Promise<string> {
      const encryptedPath = join(tempDir, `${baseName}.archive.gz.age`);
      const decryptedPath = join(tempDir, `${baseName}.archive.gz`);

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

    // 6. Restore unencrypted archives into isolated target databases
    await execFileAsync("mongorestore", [
      `--uri=${mongodbUri}`,
      `--archive=${tenantADecrypted}`,
      "--gzip",
      "--nsFrom=tenant_a.*",
      "--nsTo=tenant_a_restored.*",
      "--drop",
    ]);

    await execFileAsync("mongorestore", [
      `--uri=${mongodbUri}`,
      `--archive=${tenantBDecrypted}`,
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
