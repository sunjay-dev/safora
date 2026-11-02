import { HeadObjectCommand, type HeadObjectCommandOutput, ListObjectsV2Command, type ListObjectsV2CommandOutput, S3Client } from "@aws-sdk/client-s3";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../config/env.config.js";
import { sha256File } from "../lib/hash.js";
import { deliverArchive } from "./deliver.js";
import { createS3Destination } from "./s3.js";

const ARCHIVE_CONTENT = "s3-archive-payload\n";

describe("createS3Destination", () => {
  let tempDir: string;
  let archivePath: string;
  let config: Config;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "s3-destination-test-"));
    archivePath = join(tempDir, "backup.archive.gz.age");
    await writeFile(archivePath, ARCHIVE_CONTENT);

    config = loadConfig({
      MONGODB_URI: "mongodb://localhost:27017/test",
      AGE_RECIPIENT: "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p",
      DESTINATIONS: "s3",
      S3_BUCKET: "my-production-bucket",
      S3_REGION: "us-west-2",
      S3_ACCESS_KEY_ID: "mock-key",
      S3_SECRET_ACCESS_KEY: "mock-secret",
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("exports createS3Destination returning a Destination with id 's3'", () => {
    const destination = createS3Destination(config);
    expect(destination.id).toBe("s3");
    expect(typeof destination.deliver).toBe("function");
    expect(typeof destination.prune).toBe("function");
  });

  it("delivers archive and reports s3://${bucket}/${objectKey} location, bytes, and sha256", async () => {
    const client = new S3Client({ region: "us-west-2" });
    const expectedBytes = Buffer.byteLength(ARCHIVE_CONTENT);
    const expectedSha256 = await sha256File(archivePath);
    const objectKey = "backups/mongodb/2026-11-01_12-00-00/app.archive.gz.age";

    vi.spyOn(client, "send").mockImplementation(async (command) => {
      if (command instanceof HeadObjectCommand) {
        expect(command.input.Bucket).toBe("my-production-bucket");
        expect(command.input.Key).toBe(objectKey);
        return { ContentLength: expectedBytes, $metadata: {} } as HeadObjectCommandOutput as never;
      }
      return { $metadata: {} } as never;
    });

    const destination = createS3Destination(config, { client });
    const result = await destination.deliver(archivePath, objectKey);

    expect(result).toEqual({
      location: `s3://my-production-bucket/${objectKey}`,
      bytes: expectedBytes,
      sha256: expectedSha256,
    });
  });

  it("prunes expired backups using retention policy", async () => {
    const client = new S3Client({ region: "us-west-2" });
    const objectKey = "backups/mongodb/2026-11-01_12-00-00/app.archive.gz.age";

    vi.spyOn(client, "send").mockImplementation(async (command) => {
      if (command instanceof ListObjectsV2Command) {
        return {
          Contents: [],
          IsTruncated: false,
          $metadata: {},
        } as ListObjectsV2CommandOutput as never;
      }
      return { $metadata: {} } as never;
    });

    const destination = createS3Destination(config, { client });
    const pruned = await destination.prune(objectKey);
    expect(pruned).toEqual([]);
  });

  it("integrates with deliverArchive to record successful and failed outcomes", async () => {
    const successClient = new S3Client({ region: "us-west-2" });
    const expectedBytes = Buffer.byteLength(ARCHIVE_CONTENT);
    const objectKey = "backups/test.age";

    vi.spyOn(successClient, "send").mockImplementation(async (command) => {
      if (command instanceof HeadObjectCommand) {
        return { ContentLength: expectedBytes, $metadata: {} } as HeadObjectCommandOutput as never;
      }
      if (command instanceof ListObjectsV2Command) {
        return { Contents: [], IsTruncated: false, $metadata: {} } as ListObjectsV2CommandOutput as never;
      }
      return { $metadata: {} } as never;
    });

    const failingClient = new S3Client({ region: "us-west-2" });
    vi.spyOn(failingClient, "send").mockRejectedValue(new Error("S3 Service Unavailable"));

    const s3Success = createS3Destination(config, { client: successClient });
    const s3Failing = createS3Destination(config, { client: failingClient });

    const outcomes = await deliverArchive([s3Success, s3Failing], archivePath, objectKey);

    expect(outcomes[0].id).toBe("s3");
    expect(outcomes[0].delivery?.location).toBe(`s3://my-production-bucket/${objectKey}`);
    expect(outcomes[0].failure).toBeNull();

    expect(outcomes[1].id).toBe("s3");
    expect(outcomes[1].delivery).toBeNull();
    expect(outcomes[1].failure?.stage).toBe("delivery");
    expect(outcomes[1].failure?.message).toContain("S3 Service Unavailable");
  });
});
