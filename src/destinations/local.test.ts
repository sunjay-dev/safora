import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../config/env.config.js";
import { deliverArchive, failedOutcomes } from "./deliver.js";
import { createLocalDestination } from "./local.js";

const ARCHIVE_BYTES = "age-encrypted archive contents\n";
const ARCHIVE_SHA256 = "838559df31149d21e29b8de3863cca5c34b25a5ae622f3076981c073ab44cdde";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-destination-"));
  temporaryDirectories.push(directory);
  return directory;
}

function localConfig(localBackupDir: string, overrides: Record<string, string> = {}): Config {
  return loadConfig({
    MONGODB_URI: "mongodb://localhost:27017/test",
    AGE_RECIPIENT: "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p",
    DESTINATIONS: "local",
    LOCAL_BACKUP_DIR: localBackupDir,
    ...overrides,
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("local destination delivery", () => {
  it("delivers the archive at the mirrored object key and creates the destination folder", async () => {
    const workspace = await temporaryDirectory();
    const backupDir = join(workspace, "backup-root");
    const sourcePath = join(workspace, "dump.archive.gz.age");
    await writeFile(sourcePath, ARCHIVE_BYTES);

    const objectKey = "backups/mongodb-2026-10-24T021715Z.archive.gz.age";
    const destination = createLocalDestination(localConfig(backupDir));

    const result = await destination.deliver(sourcePath, objectKey);

    const finalPath = join(backupDir, "backups", "mongodb-2026-10-24T021715Z.archive.gz.age");
    expect(result).toEqual({
      location: finalPath,
      bytes: Buffer.byteLength(ARCHIVE_BYTES),
      sha256: ARCHIVE_SHA256,
    });
    expect(await readFile(finalPath, "utf8")).toBe(ARCHIVE_BYTES);
    expect(await readdir(join(backupDir, "backups"))).toEqual(["mongodb-2026-10-24T021715Z.archive.gz.age"]);
  });

  it("resolves a relative LOCAL_BACKUP_DIR against the working directory", async () => {
    const workspace = await temporaryDirectory();
    const sourcePath = join(workspace, "dump.archive.gz.age");
    await writeFile(sourcePath, ARCHIVE_BYTES);

    const originalCwd = process.cwd();
    process.chdir(workspace);
    try {
      const destination = createLocalDestination(localConfig("relative-backups"));
      const result = await destination.deliver(sourcePath, "backups/mongodb-2026-10-24T021715Z.archive.gz.age");

      const finalPath = join(workspace, "relative-backups", "backups", "mongodb-2026-10-24T021715Z.archive.gz.age");
      expect(result.location).toBe(finalPath);
      expect(await readFile(finalPath, "utf8")).toBe(ARCHIVE_BYTES);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("fails delivery and leaves no finished archive when the copied file's hash does not match", async () => {
    const workspace = await temporaryDirectory();
    const backupDir = join(workspace, "backup-root");
    const sourcePath = join(workspace, "dump.archive.gz.age");
    await writeFile(sourcePath, ARCHIVE_BYTES);

    const objectKey = "backups/mongodb-2026-10-24T021715Z.archive.gz.age";
    const finalPath = join(backupDir, "backups", "mongodb-2026-10-24T021715Z.archive.gz.age");
    const destination = createLocalDestination(localConfig(backupDir), {
      copyFile: async (_sourcePath, destinationPath) => {
        expect(destinationPath).toBe(`${finalPath}.part`);
        expect(await fileExists(finalPath)).toBe(false);
        await writeFile(destinationPath, "corrupted copy");
      },
    });

    await expect(destination.deliver(sourcePath, objectKey)).rejects.toThrow(/Local delivery verification failed/);

    expect(await readdir(join(backupDir, "backups"))).toEqual([]);
  });

  it("refuses an object key that escapes the local backup directory", async () => {
    const workspace = await temporaryDirectory();
    const sourcePath = join(workspace, "dump.archive.gz.age");
    await writeFile(sourcePath, ARCHIVE_BYTES);
    const destination = createLocalDestination(localConfig(join(workspace, "backup-root")));

    await expect(destination.deliver(sourcePath, "../escaped.archive.gz.age")).rejects.toThrow(/outside the local backup directory/);
  });

  it("keeps delivering to the next destination after a local delivery fails", async () => {
    const workspace = await temporaryDirectory();
    const sourcePath = join(workspace, "dump.archive.gz.age");
    await writeFile(sourcePath, ARCHIVE_BYTES);

    const objectKey = "backups/mongodb-2026-10-24T021715Z.archive.gz.age";
    const failedDestination = createLocalDestination(localConfig(join(workspace, "failed-root")), {
      copyFile: async (_sourcePath, destinationPath) => {
        await writeFile(destinationPath, "corrupted copy");
      },
    });
    const workingDestination = createLocalDestination(localConfig(join(workspace, "working-root")));

    const outcomes = await deliverArchive([failedDestination, workingDestination], sourcePath, objectKey);

    expect(outcomes[0].failure?.stage).toBe("delivery");
    expect(outcomes[0].delivery).toBeNull();
    expect(outcomes[1].failure).toBeNull();
    expect(outcomes[1].delivery?.location).toBe(join(workspace, "working-root", "backups", "mongodb-2026-10-24T021715Z.archive.gz.age"));
    expect(failedOutcomes(outcomes).map((outcome) => outcome.id)).toEqual(["local"]);
  });
});

describe("local destination retention", () => {
  it("prunes only expired finished archives, ignoring .part and foreign files and protecting the current key", async () => {
    const workspace = await temporaryDirectory();
    const backupDir = join(workspace, "backup-root");
    await mkdir(join(backupDir, "backups"), { recursive: true });
    await mkdir(join(backupDir, "elsewhere"), { recursive: true });

    const expiredKey = "backups/mongodb-2026-10-01T000000Z.archive.gz.age";
    const recentKey = "backups/mongodb-2026-10-24T000000Z.archive.gz.age";
    const currentKey = "backups/mongodb-2026-10-24T021715Z.archive.gz.age";
    const partKey = "backups/mongodb-2026-10-01T000001Z.archive.gz.age.part";
    const foreignKey = "backups/notes.txt";
    const outsidePrefixKey = "elsewhere/mongodb-2026-10-01T000002Z.archive.gz.age";

    for (const key of [expiredKey, recentKey, currentKey, partKey, foreignKey, outsidePrefixKey]) {
      await writeFile(join(backupDir, key), "archive");
    }

    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    for (const key of [expiredKey, currentKey, partKey, foreignKey, outsidePrefixKey]) {
      await utimes(join(backupDir, key), tenDaysAgo, tenDaysAgo);
    }

    const destination = createLocalDestination(localConfig(backupDir, { RETENTION_DAYS: "7" }));
    const pruned = await destination.prune(currentKey);

    expect(pruned).toEqual([expiredKey]);
    expect(await fileExists(join(backupDir, expiredKey))).toBe(false);
    for (const key of [recentKey, currentKey, partKey, foreignKey, outsidePrefixKey]) {
      expect(await fileExists(join(backupDir, key))).toBe(true);
    }
  });

  it("protects the current run's key when the backup prefix is not canonical", async () => {
    const workspace = await temporaryDirectory();
    const backupDir = join(workspace, "backup-root");
    await mkdir(join(backupDir, "backups"), { recursive: true });

    const currentKey = "/backups/mongodb-2026-10-24T021715Z.archive.gz.age";
    await writeFile(join(backupDir, "backups", "mongodb-2026-10-24T021715Z.archive.gz.age"), "archive");
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await utimes(join(backupDir, "backups", "mongodb-2026-10-24T021715Z.archive.gz.age"), tenDaysAgo, tenDaysAgo);

    const destination = createLocalDestination(localConfig(backupDir, { BACKUP_PREFIX: "/backups/", RETENTION_DAYS: "7" }));

    await expect(destination.prune(currentKey)).resolves.toEqual([]);
    expect(await fileExists(join(backupDir, "backups", "mongodb-2026-10-24T021715Z.archive.gz.age"))).toBe(true);
  });

  it("prunes nothing when the backup prefix folder does not exist", async () => {
    const workspace = await temporaryDirectory();
    const destination = createLocalDestination(localConfig(join(workspace, "backup-root")));

    await expect(destination.prune("backups/mongodb-2026-10-24T021715Z.archive.gz.age")).resolves.toEqual([]);
  });

  it("delivers to date/time and engine subfolders and cleans up empty subfolders when archives are pruned", async () => {
    const workspace = await temporaryDirectory();
    const backupDir = join(workspace, "backup-root");
    const destination = createLocalDestination(localConfig(backupDir, { RETENTION_DAYS: "7" }));

    const expiredEngineFolder = "backups/postgres";
    const expiredFolder = `${expiredEngineFolder}/2026-10-01_00-00-00`;
    const currentEngineFolder = "backups/postgres";
    const currentFolder = `${currentEngineFolder}/2026-10-24_02-17-15`;
    await mkdir(join(backupDir, expiredFolder), { recursive: true });
    await mkdir(join(backupDir, currentFolder), { recursive: true });

    const expiredKey1 = `${expiredFolder}/app_db.dump.age`;
    const expiredKey2 = `${expiredFolder}/analytics.dump.age`;
    const currentKey = `${currentFolder}/app_db.dump.age`;

    await writeFile(join(backupDir, expiredKey1), "archive1");
    await writeFile(join(backupDir, expiredKey2), "archive2");
    await writeFile(join(backupDir, currentKey), "archive3");

    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await utimes(join(backupDir, expiredKey1), tenDaysAgo, tenDaysAgo);
    await utimes(join(backupDir, expiredKey2), tenDaysAgo, tenDaysAgo);

    const pruned = await destination.prune(currentKey);
    expect(pruned.sort()).toEqual([expiredKey2, expiredKey1].sort());

    // Both files in expiredFolder should be deleted, and the date folder should be cleaned up
    expect(await fileExists(join(backupDir, expiredKey1))).toBe(false);
    expect(await fileExists(join(backupDir, expiredKey2))).toBe(false);
    expect(await fileExists(join(backupDir, expiredFolder))).toBe(false);

    // Current backup and its folders should remain untouched
    expect(await fileExists(join(backupDir, currentKey))).toBe(true);
    expect(await fileExists(join(backupDir, currentFolder))).toBe(true);
    expect(await fileExists(join(backupDir, currentEngineFolder))).toBe(true);
  });
});
