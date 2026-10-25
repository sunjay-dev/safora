import { describe, expect, it } from "vitest";
import { archiveObjectKey } from "./format.js";

describe("archiveObjectKey", () => {
  it("places the timestamped archive under the backup prefix", () => {
    const date = new Date("2026-10-24T02:17:15Z");

    expect(archiveObjectKey("backups/", date)).toBe(
      "backups/mongodb-2026-10-24T021715Z.archive.gz.age",
    );
  });
});
