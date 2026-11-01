import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MongoClient } from "mongodb";
import type { MongodbConfig, PostgresConfig } from "../config/env.config.js";
import type { ExecFileFn } from "../lib/exec.js";
import { enumerateMongodbDatabases, enumeratePostgresDatabases, runMongodbDump, runPostgresDump, verifyPostgresArchive } from "./dump.js";

const basePostgresConfig: PostgresConfig = {
  ENGINE: "postgres",
  POSTGRESQL_URI: "postgresql://backup-user:secret-pass@db.internal:5432/postgres",
  AGE_RECIPIENT: "age1mock",
  LOG_LEVEL: "info",
  RETENTION_DAYS: 30,
  BACKUP_PREFIX: "backups/",
  DUMP_TIMEOUT_MS: 5000,
  TOOL_CHECK_TIMEOUT_MS: 1000,
  MAX_BUFFER: 1024 * 1024,
  DESTINATIONS: ["local"],
};

describe("verifyPostgresArchive", () => {
  it("succeeds when pg_restore --list returns non-empty table of contents", async () => {
    const fakeExec = (async () => ({
      stdout: ";\n; Archive created by pg_dump version 17.0\n;\n",
      stderr: "",
    })) as unknown as ExecFileFn;

    const output = await verifyPostgresArchive("/tmp/fake.dump", 5000, 1024, fakeExec);
    expect(output).toContain("Archive created by pg_dump");
  });

  it("fails the run when pg_restore --list produces empty output", async () => {
    const fakeExec = (async () => ({
      stdout: "   \n\t  ",
      stderr: "",
    })) as unknown as ExecFileFn;

    await expect(verifyPostgresArchive("/tmp/fake.dump", 5000, 1024, fakeExec)).rejects.toThrowError(
      /pg_restore --list reported success but produced empty output/,
    );
  });

  it("fails the run when pg_restore --list process fails", async () => {
    const fakeExec = (async () => {
      const error = Object.assign(new Error("invalid archive header"), {
        stderr: "pg_restore: error: input file does not appear to be a valid archive",
      });
      throw error;
    }) as unknown as ExecFileFn;

    await expect(verifyPostgresArchive("/tmp/fake.dump", 5000, 1024, fakeExec)).rejects.toThrowError(/pg_restore --list failed:/);
  });
});

describe("enumeratePostgresDatabases", () => {
  it("queries psql to enumerate databases and filters templates and non-connectable databases", async () => {
    const executed: Array<{ cmd: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
    const fakeExec = (async (cmd: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
      executed.push({ cmd, args, env: options?.env });
      return { stdout: "postgres\napp_db\nreporting\n", stderr: "" };
    }) as unknown as ExecFileFn;

    const databases = await enumeratePostgresDatabases(basePostgresConfig, "/tmp/fake.pgpass", fakeExec);

    expect(databases).toEqual(["postgres", "app_db", "reporting"]);
    expect(executed).toHaveLength(1);
    expect(executed[0].cmd).toBe("psql");
    expect(executed[0].env?.PGPASSFILE).toBe("/tmp/fake.pgpass");

    // Verify SQL filter query excludes templates and non-connectable databases
    const queryArgIndex = executed[0].args.indexOf("-c");
    expect(queryArgIndex).toBeGreaterThanOrEqual(0);
    const query = executed[0].args[queryArgIndex + 1];
    expect(query).toContain("datallowconn");
    expect(query).toContain("NOT datistemplate");

    // Content-asserted: password must NOT appear anywhere in psql arguments
    expect(executed[0].args.join(" ")).not.toContain("secret-pass");
  });

  it("fails loudly when zero candidate databases are found", async () => {
    const fakeExec = (async () => ({
      stdout: "   \n\n  ",
      stderr: "",
    })) as unknown as ExecFileFn;

    await expect(enumeratePostgresDatabases(basePostgresConfig, undefined, fakeExec)).rejects.toThrowError(/no databases to back up/);
  });

  it("fails with error details when psql command fails", async () => {
    const fakeExec = (async () => {
      const error = Object.assign(new Error("psql connection error"), {
        stderr: "psql: error: connection to server failed: Connection refused",
      });
      throw error;
    }) as unknown as ExecFileFn;

    await expect(enumeratePostgresDatabases(basePostgresConfig, undefined, fakeExec)).rejects.toThrowError(/psql database enumeration failed:/);
  });
});

describe("runPostgresDump execution and validation flow", () => {
  it("fails when pg_dump produces a zero-byte empty archive", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pg-dump-test-"));
    const archivePath = join(workDir, "postgres-app.dump");

    // Simulate pg_dump creating an empty 0-byte file
    const fakeExec = (async (cmd: string) => {
      if (cmd === "pg_dump") {
        await writeFile(archivePath, Buffer.alloc(0));
      }
      return { stdout: "", stderr: "" };
    }) as unknown as ExecFileFn;

    try {
      await expect(runPostgresDump(basePostgresConfig, workDir, "app", fakeExec)).rejects.toThrowError(
        /pg_dump reported success but produced an empty archive/,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("fails when pg_restore validation detects empty output", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pg-dump-test-"));
    const archivePath = join(workDir, "postgres-app.dump");

    // Simulate pg_dump creating a non-empty file, but pg_restore producing empty TOC
    const fakeExec = (async (cmd: string) => {
      if (cmd === "pg_dump") {
        await writeFile(archivePath, Buffer.from("corrupted or empty TOC content"));
        return { stdout: "", stderr: "" };
      }
      if (cmd === "pg_restore") {
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    }) as unknown as ExecFileFn;

    try {
      await expect(runPostgresDump(basePostgresConfig, workDir, "app", fakeExec)).rejects.toThrowError(
        /pg_restore --list reported success but produced empty output/,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("succeeds when pg_dump writes non-empty archive and pg_restore --list validates it", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pg-dump-test-"));
    const archivePath = join(workDir, "postgres-app.dump");
    const sampleDumpBytes = Buffer.from("PGDMP\x01\x02valid custom dump payload");

    const executedCommands: Array<{ cmd: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
    const fakeExec = (async (cmd: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
      executedCommands.push({ cmd, args, env: options?.env });
      if (cmd === "pg_dump") {
        await writeFile(archivePath, sampleDumpBytes);
        return { stdout: "", stderr: "" };
      }
      if (cmd === "pg_restore") {
        return { stdout: "1234; 1234 5678 TABLE DATA public users postgres\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    }) as unknown as ExecFileFn;

    try {
      const result = await runPostgresDump(basePostgresConfig, workDir, "app", fakeExec);

      expect(result.archivePath).toBe(archivePath);
      expect(result.bytes).toBe(sampleDumpBytes.length);

      // Verify pg_dump was invoked with format=custom and file
      const dumpInvocation = executedCommands.find((c) => c.cmd === "pg_dump");
      expect(dumpInvocation).toBeDefined();
      expect(dumpInvocation!.args).toContain("--format=custom");
      expect(dumpInvocation!.args).toContain(`--file=${archivePath}`);
      expect(dumpInvocation!.args).toContain("--dbname");
      expect(dumpInvocation!.args).toContain("postgresql://backup-user@db.internal:5432/app");
      // Assert password was NOT in pg_dump args
      expect(dumpInvocation!.args.join(" ")).not.toContain("secret-pass");
      // Assert PGPASSFILE env var was set
      expect(dumpInvocation!.env?.PGPASSFILE).toBeDefined();

      // Verify pg_restore was invoked with --list
      const restoreInvocation = executedCommands.find((c) => c.cmd === "pg_restore");
      expect(restoreInvocation).toBeDefined();
      expect(restoreInvocation!.args).toEqual(["--list", archivePath]);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

const baseMongoConfig: MongodbConfig = {
  ENGINE: "mongodb",
  MONGODB_URI: "mongodb://backup-user:secret-pass@cluster0.mongodb.net/admin",
  AGE_RECIPIENT: "age1mock",
  LOG_LEVEL: "info",
  RETENTION_DAYS: 30,
  BACKUP_PREFIX: "backups/",
  DUMP_TIMEOUT_MS: 5000,
  TOOL_CHECK_TIMEOUT_MS: 1000,
  MAX_BUFFER: 1024 * 1024,
  DESTINATIONS: ["local"],
};

describe("runMongodbDump", () => {
  it("dumps cluster with --oplog when database is omitted", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "mongo-dump-test-"));
    const archivePath = join(workDir, "dump.archive.gz");
    const fakeExec = (async (_cmd: string, args: readonly string[]) => {
      expect(args).toContain("--oplog");
      expect(args.some((a) => a.startsWith("--db="))).toBe(false);
      await writeFile(archivePath, Buffer.from("fake cluster dump"));
      return { stdout: "", stderr: "" };
    }) as unknown as ExecFileFn;

    try {
      const result = await runMongodbDump(baseMongoConfig, workDir, fakeExec);
      expect(result.archivePath).toBe(archivePath);
      expect(result.bytes).toBeGreaterThan(0);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("dumps specific database with --db and without --oplog when database is provided", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "mongo-dump-test-"));
    const archivePath = join(workDir, "dump-my_db.archive.gz");
    const fakeExec = (async (_cmd: string, args: readonly string[]) => {
      expect(args).toContain("--db=my_db");
      expect(args).not.toContain("--oplog");
      await writeFile(archivePath, Buffer.from("fake db dump"));
      return { stdout: "", stderr: "" };
    }) as unknown as ExecFileFn;

    try {
      const result = await runMongodbDump(baseMongoConfig, workDir, fakeExec, "my_db");
      expect(result.archivePath).toBe(archivePath);
      expect(result.bytes).toBeGreaterThan(0);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

describe("enumerateMongodbDatabases", () => {
  it("lists databases excluding local system database", async () => {
    const mockClient = {
      connect: async () => {},
      db: () => ({
        admin: () => ({
          listDatabases: async () => ({
            databases: [{ name: "admin" }, { name: "local" }, { name: "app_prod" }, { name: "config" }],
          }),
        }),
      }),
      close: async () => {},
    };

    const databases = await enumerateMongodbDatabases(baseMongoConfig, () => mockClient as unknown as MongoClient);
    expect(databases).toEqual(["admin", "app_prod", "config"]);
  });

  it("fails loudly when zero databases are found", async () => {
    const mockClient = {
      connect: async () => {},
      db: () => ({
        admin: () => ({
          listDatabases: async () => ({
            databases: [{ name: "local" }],
          }),
        }),
      }),
      close: async () => {},
    };

    await expect(enumerateMongodbDatabases(baseMongoConfig, () => mockClient as unknown as MongoClient)).rejects.toThrowError(
      /no databases to back up/,
    );
  });
});
