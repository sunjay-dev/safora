import { describe, expect, it } from "vitest";
import type { MongodbConfig, PostgresConfig } from "./config/env.config.js";
import { assertPreflightTools, assertToolInstalled } from "./tools.js";

const baseConfig = {
  AGE_RECIPIENT: "age1mock",
  LOG_LEVEL: "info" as const,
  RETENTION_DAYS: 30,
  BACKUP_PREFIX: "backups/",
  DUMP_TIMEOUT_MS: 1000,
  TOOL_CHECK_TIMEOUT_MS: 1000,
  MAX_BUFFER: 1024,
  DESTINATIONS: ["local" as const],
};

const mongodbConfig: MongodbConfig = {
  ...baseConfig,
  ENGINE: "mongodb",
  MONGODB_URI: "mongodb://localhost:27017/test",
};

const postgresConfig: PostgresConfig = {
  ...baseConfig,
  ENGINE: "postgres",
  POSTGRESQL_URI: "postgresql://localhost:5432/test",
};

describe("assertToolInstalled", () => {
  it("returns stdout of a successfully executed tool", async () => {
    // node is guaranteed to be on PATH in this environment
    const version = await assertToolInstalled(mongodbConfig, "node", ["--version"]);
    expect(version).toMatch(/^v\d+/);
  });

  it("fails with a helpful error when tool is not on PATH", async () => {
    await expect(assertToolInstalled(mongodbConfig, "nonexistent-tool-xyz", ["--version"])).rejects.toThrowError(
      /Required tool "nonexistent-tool-xyz" is not on PATH or failed to start/,
    );
  });
});

describe("assertPreflightTools", () => {
  it("checks only mongodump for mongodb engine", async () => {
    const result = await assertPreflightTools(mongodbConfig);
    expect(result).toHaveProperty("mongodump");
    expect(result.mongodump).toContain("mongodump");
    expect(result).not.toHaveProperty("pg_dump");
    expect(result).not.toHaveProperty("pg_restore");
  });

  it("checks pg_dump and pg_restore for postgres engine", async () => {
    await expect(assertPreflightTools(postgresConfig)).rejects.toThrowError(/Required tool "pg_dump" is not on PATH or failed to start/);
  });
});
