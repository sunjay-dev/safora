import { describe, expect, it } from "vitest";
import { archiveObjectKey, isArchiveFileName } from "./format.js";

describe("archiveObjectKey", () => {
  it("places the mongodb archive under the backup prefix", () => {
    const date = new Date("2026-10-24T02:17:15Z");

    expect(archiveObjectKey("backups/", "mongodb", date)).toBe("backups/mongodb-2026-10-24T021715Z.archive.gz.age");
  });

  it("places the postgres dump under the backup prefix", () => {
    const date = new Date("2026-10-24T02:17:15Z");

    expect(archiveObjectKey("backups/", "postgres", date)).toBe("backups/postgres-2026-10-24T021715Z.dump.age");
  });
});

describe("isArchiveFileName", () => {
  it("accepts a finished mongodb archive name", () => {
    expect(isArchiveFileName("mongodb-2026-10-24T021715Z.archive.gz.age")).toBe(true);
  });

  it("accepts a finished postgres dump name", () => {
    expect(isArchiveFileName("postgres-2026-10-24T021715Z.dump.age")).toBe(true);
  });

  it("rejects staging files and foreign files", () => {
    expect(isArchiveFileName("mongodb-2026-10-24T021715Z.archive.gz.age.part")).toBe(false);
    expect(isArchiveFileName("postgres-2026-10-24T021715Z.dump.age.part")).toBe(false);
    expect(isArchiveFileName("notes.txt")).toBe(false);
    expect(isArchiveFileName("mongodb-latest.archive.gz.age")).toBe(false);
    expect(isArchiveFileName("mongodb-2026-10-24T021715Z.archive.gz")).toBe(false);
    expect(isArchiveFileName("postgres-2026-10-24T021715Z.dump")).toBe(false);
  });
});
