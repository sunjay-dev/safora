import { describe, expect, it } from "vitest";
import { retentionCutoff, selectKeysToDelete, type RetentionCandidate } from "./retention-policy.js";

const cutoff = new Date("2026-10-01T00:00:00.000Z");
const currentKey = "backups/mongodb-current.archive.gz.age";

describe("retentionCutoff", () => {
  it("subtracts the retention window from now", () => {
    const now = Date.parse("2026-10-24T00:00:00.000Z");

    expect(retentionCutoff(30, now).toISOString()).toBe("2026-09-24T00:00:00.000Z");
  });
});

describe("selectKeysToDelete", () => {
  it("selects nothing when there are no items", () => {
    expect(selectKeysToDelete([], cutoff, currentKey)).toEqual([]);
  });

  it("selects only items strictly older than the cutoff", () => {
    const items: RetentionCandidate[] = [
      { key: "backups/one-millisecond-before", modifiedAt: new Date(cutoff.getTime() - 1) },
      { key: "backups/exactly-at-cutoff", modifiedAt: cutoff },
      { key: "backups/one-millisecond-after", modifiedAt: new Date(cutoff.getTime() + 1) },
    ];

    expect(selectKeysToDelete(items, cutoff, currentKey)).toEqual(["backups/one-millisecond-before"]);
  });

  it("never selects the current run's key", () => {
    const items: RetentionCandidate[] = [
      { key: currentKey, modifiedAt: new Date(cutoff.getTime() - 60_000) },
      { key: "backups/mongodb-older.archive.gz.age", modifiedAt: new Date(cutoff.getTime() - 120_000) },
    ];

    expect(selectKeysToDelete(items, cutoff, currentKey)).toEqual(["backups/mongodb-older.archive.gz.age"]);
  });
});
