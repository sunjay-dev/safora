import { describe, expect, it } from "vitest";
import { archiveObjectKey, isArchiveFileName } from "./format.js";

describe("archiveObjectKey", () => {
  it("places the timestamped archive under the backup prefix", () => {
    const date = new Date("2026-10-24T02:17:15Z");

    expect(archiveObjectKey("backups/", date)).toBe("backups/mongodb-2026-10-24T021715Z.archive.gz.age");
  });
});

describe("isArchiveFileName", () => {
  it("accepts a finished archive name", () => {
    expect(isArchiveFileName("mongodb-2026-10-24T021715Z.archive.gz.age")).toBe(true);
  });

  it("rejects staging files and foreign files", () => {
    expect(isArchiveFileName("mongodb-2026-10-24T021715Z.archive.gz.age.part")).toBe(false);
    expect(isArchiveFileName("notes.txt")).toBe(false);
    expect(isArchiveFileName("mongodb-latest.archive.gz.age")).toBe(false);
    expect(isArchiveFileName("mongodb-2026-10-24T021715Z.archive.gz")).toBe(false);
  });
});
