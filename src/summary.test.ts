import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DestinationOutcome } from "./destinations/deliver.js";
import { renderSummary, writeSummary } from "./summary.js";

const delivered: DestinationOutcome = {
  id: "s3",
  delivery: {
    location: "s3://mock-bucket/backups/mongodb-2026-10-24T021715Z.archive.gz.age",
    bytes: 31,
    sha256: "838559df31149d21e29b8de3863cca5c34b25a5ae622f3076981c073ab44cdde",
  },
  pruned: ["backups/mongodb-2026-09-01T000000Z.archive.gz.age"],
  failure: null,
};

const failed: DestinationOutcome = {
  id: "local",
  delivery: null,
  pruned: [],
  failure: { stage: "delivery", message: "disk full" },
};

describe("renderSummary", () => {
  it("renders one block per destination and names failed destinations", () => {
    const summary = renderSummary([delivered, failed], 30, "backups/mongodb-2026-10-24T021715Z.archive.gz.age").join("\n");

    expect(summary).toContain("### MongoDB backup summary");
    expect(summary).toContain("#### s3");
    expect(summary).toContain("#### local");
    expect(summary).toContain("**Failed destinations:** `local`");
  });

  it("renders a custom title when provided for postgres per-database summary", () => {
    const summary = renderSummary(
      [delivered],
      30,
      "backups/postgres-app_db-2026-10-24T021715Z.dump.age",
      "### PostgreSQL backup summary (app_db)",
    ).join("\n");

    expect(summary).toContain("### PostgreSQL backup summary (app_db)");
    expect(summary).toContain("#### s3");
  });
});

describe("writeSummary", () => {
  afterEach(() => {
    delete process.env.GITHUB_STEP_SUMMARY;
    vi.restoreAllMocks();
  });

  it("prints the summary to stdout outside CI", async () => {
    delete process.env.GITHUB_STEP_SUMMARY;
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await writeSummary(["### MongoDB backup summary", "", "#### local"]);

    expect(write).toHaveBeenCalledWith("### MongoDB backup summary\n\n#### local\n");
  });

  it("appends the summary to the GitHub step summary when set", async () => {
    const directory = await mkdtemp(join(tmpdir(), "summary-"));
    const summaryPath = join(directory, "summary.md");
    process.env.GITHUB_STEP_SUMMARY = summaryPath;

    try {
      await writeSummary(["### MongoDB backup summary"]);

      expect(await readFile(summaryPath, "utf8")).toBe("### MongoDB backup summary\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
