import { describe, expect, it } from "vitest";
import { archiveObjectKey, isArchiveFileName } from "./format.js";

describe("archiveObjectKey", () => {
  it("places the mongodb archive under the backup prefix", () => {
    const date = new Date("2026-10-24T02:17:15Z");

    expect(archiveObjectKey("backups/", "mongodb", date)).toBe("backups/mongodb-2026-10-24T021715Z.archive.gz.age");
    expect(archiveObjectKey("backups/", "mongodb", date, "app_db")).toBe("backups/mongodb-app_db-2026-10-24T021715Z.archive.gz.age");
  });

  it("places the postgres dump under the backup prefix with per-database naming", () => {
    const date = new Date("2026-10-24T02:17:15Z");

    expect(archiveObjectKey("backups/", "postgres", date, "app_db")).toBe("backups/postgres-app_db-2026-10-24T021715Z.dump.age");
    expect(archiveObjectKey("backups/", "postgres", date, "postgres")).toBe("backups/postgres-postgres-2026-10-24T021715Z.dump.age");
  });

  it("throws when database is omitted for postgres archive key", () => {
    const date = new Date("2026-10-24T02:17:15Z");
    expect(() => (archiveObjectKey as (p: string, e: string, d: Date) => string)("backups/", "postgres", date)).toThrowError(
      /database is required for postgres archive filename/,
    );
  });
});

describe("isArchiveFileName", () => {
  it("accepts a finished mongodb archive name", () => {
    expect(isArchiveFileName("mongodb-2026-10-24T021715Z.archive.gz.age")).toBe(true);
    expect(isArchiveFileName("mongodb-app_db-2026-10-24T021715Z.archive.gz.age")).toBe(true);
  });

  it("accepts a finished postgres per-database dump name", () => {
    expect(isArchiveFileName("postgres-app_db-2026-10-24T021715Z.dump.age")).toBe(true);
    expect(isArchiveFileName("postgres-postgres-2026-10-24T021715Z.dump.age")).toBe(true);
    expect(isArchiveFileName("postgres-analytics-data-2026-10-24T021715Z.dump.age")).toBe(true);
  });

  it("rejects superseded postgres dump names without database identifier", () => {
    expect(isArchiveFileName("postgres-2026-10-24T021715Z.dump.age")).toBe(false);
  });

  it("rejects staging files and foreign files", () => {
    expect(isArchiveFileName("mongodb-2026-10-24T021715Z.archive.gz.age.part")).toBe(false);
    expect(isArchiveFileName("postgres-app_db-2026-10-24T021715Z.dump.age.part")).toBe(false);
    expect(isArchiveFileName("notes.txt")).toBe(false);
    expect(isArchiveFileName("mongodb-latest.archive.gz.age")).toBe(false);
    expect(isArchiveFileName("mongodb-2026-10-24T021715Z.archive.gz")).toBe(false);
    expect(isArchiveFileName("postgres-app_db-2026-10-24T021715Z.dump")).toBe(false);
  });
});
