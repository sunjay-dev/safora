import { HeadObjectCommand, type HeadObjectCommandOutput, S3Client } from "@aws-sdk/client-s3";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../config/env.config.js";
import { sha256File } from "../lib/hash.js";
import { uploadAndVerify } from "./upload.js";

const ARCHIVE_CONTENT = "dummy-encrypted-backup-archive-content\n";

describe("uploadAndVerify", () => {
  let tempDir: string;
  let filePath: string;
  let config: Config;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "s3-upload-test-"));
    filePath = join(tempDir, "backup.archive.gz.age");
    await writeFile(filePath, ARCHIVE_CONTENT);

    config = loadConfig({
      MONGODB_URI: "mongodb://localhost:27017/test",
      AGE_RECIPIENT: "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p",
      S3_BUCKET: "test-s3-bucket",
      S3_REGION: "us-east-1",
      S3_ACCESS_KEY_ID: "test-key",
      S3_SECRET_ACCESS_KEY: "test-secret",
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("uploads file and verifies size with HeadObjectCommand", async () => {
    const client = new S3Client({ region: "us-east-1" });
    const expectedSha256 = await sha256File(filePath);
    const expectedBytes = Buffer.byteLength(ARCHIVE_CONTENT);

    const sentCommands: unknown[] = [];
    vi.spyOn(client, "send").mockImplementation(async (command) => {
      sentCommands.push(command);
      if (command instanceof HeadObjectCommand) {
        expect(command.input.Bucket).toBe("test-s3-bucket");
        expect(command.input.Key).toBe("backups/mongodb-2026-11-01.archive.gz.age");
        return { ContentLength: expectedBytes, $metadata: {} } as HeadObjectCommandOutput as never;
      }
      return { $metadata: {} } as never;
    });

    const result = await uploadAndVerify(config, client, filePath, "backups/mongodb-2026-11-01.archive.gz.age");

    expect(result).toEqual({
      bytes: expectedBytes,
      sha256: expectedSha256,
    });
    expect(sentCommands.some((cmd) => cmd instanceof HeadObjectCommand)).toBe(true);
  });

  it("fails verification with generic S3 error when HeadObject reports mismatched size", async () => {
    const client = new S3Client({ region: "us-east-1" });
    const expectedBytes = Buffer.byteLength(ARCHIVE_CONTENT);
    const mismatchedBytes = expectedBytes - 5;

    vi.spyOn(client, "send").mockImplementation(async (command) => {
      if (command instanceof HeadObjectCommand) {
        return { ContentLength: mismatchedBytes, $metadata: {} } as HeadObjectCommandOutput as never;
      }
      return { $metadata: {} } as never;
    });

    await expect(uploadAndVerify(config, client, filePath, "backups/mismatch.archive.gz.age")).rejects.toThrowError(
      `Upload verification failed: S3 reports ${mismatchedBytes} bytes for backups/mismatch.archive.gz.age, local file is ${expectedBytes}.`,
    );
  });

  it("fails verification when HeadObject reports undefined ContentLength", async () => {
    const client = new S3Client({ region: "us-east-1" });
    const expectedBytes = Buffer.byteLength(ARCHIVE_CONTENT);

    vi.spyOn(client, "send").mockImplementation(async (command) => {
      if (command instanceof HeadObjectCommand) {
        return { ContentLength: undefined, $metadata: {} } as HeadObjectCommandOutput as never;
      }
      return { $metadata: {} } as never;
    });

    await expect(uploadAndVerify(config, client, filePath, "backups/undefined-size.archive.gz.age")).rejects.toThrowError(
      `Upload verification failed: S3 reports ? bytes for backups/undefined-size.archive.gz.age, local file is ${expectedBytes}.`,
    );
  });

  it("propagates upload failure if client send fails during upload", async () => {
    const client = new S3Client({ region: "us-east-1" });

    vi.spyOn(client, "send").mockRejectedValue(new Error("Connection reset by peer"));

    await expect(uploadAndVerify(config, client, filePath, "backups/failed.archive.gz.age")).rejects.toThrowError("Connection reset by peer");
  });
});
