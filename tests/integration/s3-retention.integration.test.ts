import { randomBytes } from "node:crypto";
import {
  type DeleteObjectsCommandOutput,
  DeleteObjectsCommand,
  HeadObjectCommand,
  type ListObjectsV2CommandOutput,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.config.js";
import { createS3Destination } from "../../src/destinations/s3.js";
import { buildS3Client } from "../../src/storage/client.js";

describe("S3 retention pruning integration tests against live MinIO", () => {
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
    RETENTION_DAYS: "14",
    S3_ENDPOINT: endpoint,
    S3_BUCKET: bucket,
    S3_REGION: region,
    S3_ACCESS_KEY_ID: accessKeyId,
    S3_SECRET_ACCESS_KEY: secretAccessKey,
    S3_FORCE_PATH_STYLE: forcePathStyle,
  });

  const realClient = buildS3Client(testConfig);

  const runId = Date.now();
  const testPrefix = `backups/retention-test-${runId}/`;

  // Custom config using the unique test run prefix
  const retentionConfig = {
    ...testConfig,
    BACKUP_PREFIX: testPrefix,
  };

  const expiredKey1 = `${testPrefix}postgres/2026-09-01_12-00-00/db_alpha.dump.age`;
  const expiredKey2 = `${testPrefix}postgres/2026-09-10_12-00-00/db_beta.dump.age`;
  const activeKey = `${testPrefix}postgres/2026-10-30_12-00-00/db_gamma.dump.age`;
  const currentKey = `${testPrefix}postgres/2026-11-02_12-00-00/db_current.dump.age`;

  const now = Date.now();
  const simulatedExpiredTimestamps: Record<string, Date> = {
    [expiredKey1]: new Date(now - 30 * 24 * 60 * 60 * 1000), // 30 days old (> 14 days)
    [expiredKey2]: new Date(now - 20 * 24 * 60 * 60 * 1000), // 20 days old (> 14 days)
    [activeKey]: new Date(now - 3 * 24 * 60 * 60 * 1000), // 3 days old (< 14 days)
    [currentKey]: new Date(now - 40 * 24 * 60 * 60 * 1000), // Even if older, currentKey is protected
  };

  beforeAll(async () => {
    // Seed synthetic backup archives into live MinIO under configured backup prefix
    const dummyPayload = randomBytes(1024);
    for (const key of [expiredKey1, expiredKey2, activeKey, currentKey]) {
      await realClient.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: dummyPayload,
          ContentType: "application/octet-stream",
        }),
      );
    }

    // Verify all 4 objects exist in MinIO before retention pruning
    for (const key of [expiredKey1, expiredKey2, activeKey, currentKey]) {
      const head = await realClient.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      expect(head.ContentLength).toBe(1024);
    }
  });

  it("prunes expired candidates via DeleteObjects batch deletion while preserving active and current archives", async () => {
    let listObjectsCalled = false;
    let deleteObjectsCalled = false;

    // Wrap realClient to attach simulated expired timestamps to the live ListObjectsV2 response
    const clientWithSimulatedDates = {
      send: async (command: unknown) => {
        if (command instanceof ListObjectsV2Command) {
          listObjectsCalled = true;
          const output = (await realClient.send(command)) as ListObjectsV2CommandOutput;
          if (output.Contents) {
            for (const item of output.Contents) {
              if (item.Key && simulatedExpiredTimestamps[item.Key]) {
                item.LastModified = simulatedExpiredTimestamps[item.Key];
              }
            }
          }
          return output;
        }

        if (command instanceof DeleteObjectsCommand) {
          deleteObjectsCalled = true;
          return (await realClient.send(command)) as DeleteObjectsCommandOutput;
        }

        return (await realClient.send(command as never)) as never;
      },
    } as unknown as S3Client;

    const s3Destination = createS3Destination(retentionConfig, { client: clientWithSimulatedDates });

    // Execute retention pruning
    const prunedKeys = await s3Destination.prune(currentKey);

    // Verify APIs were called
    expect(listObjectsCalled).toBe(true);
    expect(deleteObjectsCalled).toBe(true);

    // Assert returned pruned keys
    expect(prunedKeys).toHaveLength(2);
    expect(prunedKeys).toContain(expiredKey1);
    expect(prunedKeys).toContain(expiredKey2);
    expect(prunedKeys).not.toContain(activeKey);
    expect(prunedKeys).not.toContain(currentKey);

    // Directly verify against live MinIO that expired object keys have been deleted
    for (const expiredKey of [expiredKey1, expiredKey2]) {
      await expect(realClient.send(new HeadObjectCommand({ Bucket: bucket, Key: expiredKey }))).rejects.toThrow();
    }

    // Directly verify against live MinIO that active and current backup keys remain present
    for (const preservedKey of [activeKey, currentKey]) {
      const head = await realClient.send(new HeadObjectCommand({ Bucket: bucket, Key: preservedKey }));
      expect(head.ContentLength).toBe(1024);
    }
  });
});
