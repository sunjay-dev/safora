import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.config.js";
import { createS3Destination } from "../../src/destinations/s3.js";
import { buildS3Client } from "../../src/storage/client.js";

describe("S3 destination integration tests against live MinIO", () => {
  const endpoint = process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000";
  const bucket = process.env.S3_BUCKET ?? "test-bucket";
  const region = process.env.S3_REGION ?? "us-east-1";
  const accessKeyId = process.env.S3_ACCESS_KEY_ID ?? "minioadmin";
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin";
  const forcePathStyle = process.env.S3_FORCE_PATH_STYLE ?? "true";

  const testConfig = loadConfig({
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

  const s3Client = buildS3Client(testConfig);
  const s3Destination = createS3Destination(testConfig, { client: s3Client });

  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), "s3-delivery-test-"));
  });

  afterAll(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("delivers archive to MinIO with path-style addressing and verifies byte count and SHA-256 via HeadObject and GetObject", async () => {
    // Generate simulated encrypted archive payload (128 KB with random data)
    const payload = randomBytes(128 * 1024);
    const expectedSha256 = createHash("sha256").update(payload).digest("hex");
    const expectedBytes = payload.length;

    const archivePath = join(tempDir, "test-database.dump.age");
    await fs.writeFile(archivePath, payload);

    const objectKey = `backups/postgres/2026-11-02_12-00-00/test-database-${Date.now()}.dump.age`;

    // Deliver archive via S3 destination
    const deliveryResult = await s3Destination.deliver(archivePath, objectKey);

    expect(deliveryResult.location).toBe(`s3://${bucket}/${objectKey}`);
    expect(deliveryResult.bytes).toBe(expectedBytes);
    expect(deliveryResult.sha256).toBe(expectedSha256);

    // Verify metadata via HeadObject call against live MinIO API
    const headResult = await s3Client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: objectKey,
      }),
    );

    expect(headResult.ContentLength).toBe(expectedBytes);
    expect(headResult.Metadata?.["sha-256"]).toBe(expectedSha256);

    // Verify payload content and checksum via GetObject call against live MinIO API
    const getResult = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: objectKey,
      }),
    );

    expect(getResult.Body).toBeDefined();
    const downloadedBytes = Buffer.from(await getResult.Body!.transformToByteArray());
    expect(downloadedBytes.length).toBe(expectedBytes);
    expect(downloadedBytes.equals(payload)).toBe(true);

    const downloadedSha256 = createHash("sha256").update(downloadedBytes).digest("hex");
    expect(downloadedSha256).toBe(expectedSha256);
  });
});
