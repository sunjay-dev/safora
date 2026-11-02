import {
  type DeleteObjectsCommandOutput,
  DeleteObjectsCommand,
  type ListObjectsV2CommandOutput,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/env.config.js";
import { pruneExpiredBackups } from "./retention.js";

const baseConfig = loadConfig({
  MONGODB_URI: "mongodb://localhost:27017/test",
  AGE_RECIPIENT: "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p",
  S3_BUCKET: "retention-test-bucket",
  RETENTION_DAYS: "7",
});

describe("pruneExpiredBackups", () => {
  it("enumerates objects, deletes expired ones, and protects the current key", async () => {
    const client = new S3Client({ region: "us-east-1" });
    const now = Date.now();
    const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000);

    const expiredKey1 = "backups/mongodb-2026-10-01T000000Z.archive.gz.age";
    const expiredKey2 = "backups/mongodb-2026-10-02T000000Z.archive.gz.age";
    const recentKey = "backups/mongodb-2026-10-24T000000Z.archive.gz.age";
    const currentKey = "backups/mongodb-2026-10-01T000000Z.archive.gz.age"; // Even if old, must be protected

    const sentCommands: unknown[] = [];
    vi.spyOn(client, "send").mockImplementation(async (command) => {
      sentCommands.push(command);
      if (command instanceof ListObjectsV2Command) {
        expect(command.input.Bucket).toBe("retention-test-bucket");
        expect(command.input.Prefix).toBe("backups/");
        return {
          Contents: [
            { Key: expiredKey1, LastModified: tenDaysAgo },
            { Key: expiredKey2, LastModified: tenDaysAgo },
            { Key: recentKey, LastModified: twoDaysAgo },
            { Key: "backups/invalid-missing-date" },
            {},
          ],
          IsTruncated: false,
          $metadata: {},
        } as ListObjectsV2CommandOutput as never;
      }
      if (command instanceof DeleteObjectsCommand) {
        expect(command.input.Bucket).toBe("retention-test-bucket");
        return { $metadata: {} } as DeleteObjectsCommandOutput as never;
      }
      return { $metadata: {} } as never;
    });

    // Run with currentKey matching expiredKey1
    const pruned = await pruneExpiredBackups(baseConfig, client, currentKey);

    expect(pruned).toEqual([expiredKey2]);

    const deleteCommand = sentCommands.find((cmd) => cmd instanceof DeleteObjectsCommand) as DeleteObjectsCommand;
    expect(deleteCommand).toBeDefined();
    expect(deleteCommand.input.Delete?.Objects).toEqual([{ Key: expiredKey2 }]);
    expect(deleteCommand.input.Delete?.Quiet).toBe(true);
  });

  it("handles pagination via ContinuationToken", async () => {
    const client = new S3Client({ region: "us-east-1" });
    const now = Date.now();
    const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000);

    let listCallCount = 0;
    vi.spyOn(client, "send").mockImplementation(async (command) => {
      if (command instanceof ListObjectsV2Command) {
        listCallCount++;
        if (listCallCount === 1) {
          expect(command.input.ContinuationToken).toBeUndefined();
          return {
            Contents: [{ Key: "backups/page1-old.age", LastModified: tenDaysAgo }],
            IsTruncated: true,
            NextContinuationToken: "token-page-2",
            $metadata: {},
          } as ListObjectsV2CommandOutput as never;
        }
        if (listCallCount === 2) {
          expect(command.input.ContinuationToken).toBe("token-page-2");
          return {
            Contents: [{ Key: "backups/page2-old.age", LastModified: tenDaysAgo }],
            IsTruncated: false,
            $metadata: {},
          } as ListObjectsV2CommandOutput as never;
        }
      }
      if (command instanceof DeleteObjectsCommand) {
        return { $metadata: {} } as DeleteObjectsCommandOutput as never;
      }
      return { $metadata: {} } as never;
    });

    const pruned = await pruneExpiredBackups(baseConfig, client, "backups/current.age");
    expect(pruned).toEqual(["backups/page1-old.age", "backups/page2-old.age"]);
    expect(listCallCount).toBe(2);
  });

  it("does not send DeleteObjectsCommand when no objects are expired", async () => {
    const client = new S3Client({ region: "us-east-1" });
    const now = Date.now();
    const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000);

    const sentCommands: unknown[] = [];
    vi.spyOn(client, "send").mockImplementation(async (command) => {
      sentCommands.push(command);
      if (command instanceof ListObjectsV2Command) {
        return {
          Contents: [{ Key: "backups/recent.age", LastModified: twoDaysAgo }],
          IsTruncated: false,
          $metadata: {},
        } as ListObjectsV2CommandOutput as never;
      }
      return { $metadata: {} } as never;
    });

    const pruned = await pruneExpiredBackups(baseConfig, client, "backups/current.age");
    expect(pruned).toEqual([]);
    expect(sentCommands.some((cmd) => cmd instanceof DeleteObjectsCommand)).toBe(false);
  });

  it("chunks deletes into batches of 1000 when deleting more than 1000 objects", async () => {
    const client = new S3Client({ region: "us-east-1" });
    const now = Date.now();
    const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000);

    const totalExpired = 2050;
    const contents = Array.from({ length: totalExpired }, (_, i) => ({
      Key: `backups/old-${i}.age`,
      LastModified: tenDaysAgo,
    }));

    const deleteCommands: DeleteObjectsCommand[] = [];
    vi.spyOn(client, "send").mockImplementation(async (command) => {
      if (command instanceof ListObjectsV2Command) {
        return {
          Contents: contents,
          IsTruncated: false,
          $metadata: {},
        } as ListObjectsV2CommandOutput as never;
      }
      if (command instanceof DeleteObjectsCommand) {
        deleteCommands.push(command);
        return { $metadata: {} } as DeleteObjectsCommandOutput as never;
      }
      return { $metadata: {} } as never;
    });

    const pruned = await pruneExpiredBackups(baseConfig, client, "backups/current.age");
    expect(pruned.length).toBe(totalExpired);
    expect(deleteCommands.length).toBe(3);
    expect(deleteCommands[0].input.Delete?.Objects?.length).toBe(1000);
    expect(deleteCommands[1].input.Delete?.Objects?.length).toBe(1000);
    expect(deleteCommands[2].input.Delete?.Objects?.length).toBe(50);
  });
});
