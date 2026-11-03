import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createS3Destination } from "../../src/destinations/s3.js";
import { getTestS3Client } from "../helpers/s3-test-config.js";

describe("S3 destination integration tests against live MinIO", () => {
  const { s3Client, params: s3Params, testConfig } = getTestS3Client();
  const bucket = s3Params.bucket;
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
