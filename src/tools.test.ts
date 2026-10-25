import { describe, expect, it } from "vitest";
import type { MongodbConfig, PostgresConfig } from "./config/env.config.js";
import type { ExecFileFn } from "./lib/exec.js";
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
    const executed: string[] = [];
    const fakeExec = (async (cmd: string) => {
      executed.push(cmd);
      return { stdout: `${cmd} version 1.0.0\n`, stderr: "" };
    }) as unknown as ExecFileFn;

    const result = await assertPreflightTools(mongodbConfig, fakeExec);
    expect(result).toHaveProperty("mongodump");
    expect(result.mongodump).toContain("mongodump");
    expect(result).not.toHaveProperty("psql");
    expect(result).not.toHaveProperty("pg_dump");
    expect(result).not.toHaveProperty("pg_restore");
    expect(executed).toEqual(["mongodump"]);
  });

  it("checks psql, pg_dump, and pg_restore for postgres engine", async () => {
    const executed: string[] = [];
    const fakeExec = (async (cmd: string) => {
      executed.push(cmd);
      return { stdout: `${cmd} (PostgreSQL) 17.0\n`, stderr: "" };
    }) as unknown as ExecFileFn;

    const result = await assertPreflightTools(postgresConfig, fakeExec);
    expect(result).toHaveProperty("psql");
    expect(result).toHaveProperty("pg_dump");
    expect(result).toHaveProperty("pg_restore");
    expect(result).not.toHaveProperty("mongodump");
    expect(executed).toEqual(["psql", "pg_dump", "pg_restore"]);
  });

  it("fails with a helpful error when a tool is missing", async () => {
    const fakeExec = (async (cmd: string) => {
      if (cmd === "psql") {
        throw new Error("ENOENT");
      }
      return { stdout: "", stderr: "" };
    }) as unknown as ExecFileFn;

    await expect(assertPreflightTools(postgresConfig, fakeExec)).rejects.toThrowError(/Required tool "psql" is not on PATH or failed to start/);
  });
});
