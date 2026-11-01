import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MongodbConfig, PostgresConfig } from "./config/env.config.js";
import type { Destination } from "./destinations/destination.js";
import type { ExecFileFn } from "./lib/exec.js";
import { runMongodbBackup, runPostgresBackup } from "./main.js";
import type { encryptArchive } from "./steps/encrypt.js";

const testConfig: PostgresConfig = {
  ENGINE: "postgres",
  POSTGRESQL_URI: "postgresql://backup-user:secret-pass@db.internal:5432/postgres?sslmode=require",
  AGE_RECIPIENT: "age1mock",
  LOG_LEVEL: "fatal", // Keep test output quiet
  RETENTION_DAYS: 30,
  BACKUP_PREFIX: "backups/",
  DUMP_TIMEOUT_MS: 5000,
  TOOL_CHECK_TIMEOUT_MS: 1000,
  MAX_BUFFER: 1024 * 1024,
  DESTINATIONS: ["local"],
};

describe("runPostgresBackup multi-database flow", () => {
  it("enumerates databases, dumps each one, encrypts, and delivers all archives", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "main-pg-test-"));
    const fixedNow = new Date("2026-10-25T12:00:00Z");

    const executedCommands: Array<{ cmd: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
    const fakeExec = (async (cmd: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
      executedCommands.push({ cmd, args, env: options?.env });
      if (cmd === "psql") {
        return { stdout: "postgres\napp_db\nreporting\n", stderr: "" };
      }
      if (cmd === "pg_dump") {
        // Find file path in args
        const fileArg = args.find((a) => a.startsWith("--file="));
        const filePath = fileArg!.replace("--file=", "");
        await writeFile(filePath, Buffer.from("valid dump payload"));
        return { stdout: "", stderr: "" };
      }
      if (cmd === "pg_restore") {
        return { stdout: "1234; TOC line\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    }) as unknown as ExecFileFn;

    const deliveredKeys: string[] = [];
    const mockDestination: Destination = {
      id: "local",
      deliver: async (_archivePath, objectKey) => {
        deliveredKeys.push(objectKey);
        return { location: `/dest/${objectKey}`, bytes: 42, sha256: "mocksha" };
      },
      prune: async () => [],
    };

    const encryptedPaths: string[] = [];
    const fakeEncrypt: typeof encryptArchive = async (_config, inputPath) => {
      encryptedPaths.push(inputPath);
      const encPath = `${inputPath}.age`;
      await writeFile(encPath, Buffer.from("encrypted age content"));
      return { encryptedPath: encPath, bytes: 42 };
    };

    try {
      await runPostgresBackup(testConfig, [mockDestination], workDir, {
        now: fixedNow,
        exec: fakeExec,
        encrypt: fakeEncrypt,
        writeSummary: async () => {},
      });

      // 1. Check psql database enumeration
      const psqlCall = executedCommands.find((c) => c.cmd === "psql");
      expect(psqlCall).toBeDefined();
      expect(psqlCall!.env?.PGPASSFILE).toBeDefined();
      expect(psqlCall!.args.join(" ")).not.toContain("secret-pass");

      // 2. Check each database was dumped and verified
      const dumpCalls = executedCommands.filter((c) => c.cmd === "pg_dump");
      expect(dumpCalls).toHaveLength(3);
      expect(dumpCalls[0].args).toContain("postgresql://backup-user@db.internal:5432/postgres?sslmode=require");
      expect(dumpCalls[1].args).toContain("postgresql://backup-user@db.internal:5432/app_db?sslmode=require");
      expect(dumpCalls[2].args).toContain("postgresql://backup-user@db.internal:5432/reporting?sslmode=require");

      // 3. Check delivery keys match per-database format
      expect(deliveredKeys).toEqual([
        "backups/2026-10-25T120000Z/postgres/postgres.dump.age",
        "backups/2026-10-25T120000Z/postgres/app_db.dump.age",
        "backups/2026-10-25T120000Z/postgres/reporting.dump.age",
      ]);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("attempts all databases and delivers surviving databases even when one database dump fails", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "main-pg-test-"));
    const fixedNow = new Date("2026-10-25T12:00:00Z");

    const executedCommands: Array<{ cmd: string; args: readonly string[] }> = [];
    const fakeExec = (async (cmd: string, args: readonly string[]) => {
      executedCommands.push({ cmd, args });
      if (cmd === "psql") {
        return { stdout: "failing_db\nsucceeding_db\n", stderr: "" };
      }
      if (cmd === "pg_dump") {
        if (args.some((a) => a.includes("failing_db"))) {
          throw new Error("connection terminated abruptly during dump");
        }
        const fileArg = args.find((a) => a.startsWith("--file="));
        const filePath = fileArg!.replace("--file=", "");
        await writeFile(filePath, Buffer.from("valid dump payload"));
        return { stdout: "", stderr: "" };
      }
      if (cmd === "pg_restore") {
        return { stdout: "1234; TOC line\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    }) as unknown as ExecFileFn;

    const deliveredKeys: string[] = [];
    const mockDestination: Destination = {
      id: "local",
      deliver: async (_archivePath, objectKey) => {
        deliveredKeys.push(objectKey);
        return { location: `/dest/${objectKey}`, bytes: 42, sha256: "mocksha" };
      },
      prune: async () => [],
    };

    const fakeEncrypt: typeof encryptArchive = async (_config, inputPath) => {
      const encPath = `${inputPath}.age`;
      await writeFile(encPath, Buffer.from("encrypted age content"));
      return { encryptedPath: encPath, bytes: 42 };
    };

    try {
      await expect(
        runPostgresBackup(testConfig, [mockDestination], workDir, {
          now: fixedNow,
          exec: fakeExec,
          encrypt: fakeEncrypt,
          writeSummary: async () => {},
        }),
      ).rejects.toThrowError(/One or more databases failed to back up: failing_db: pg_dump failed/);

      // Verify that succeeding_db was STILL dumped, encrypted, and delivered!
      expect(deliveredKeys).toEqual(["backups/2026-10-25T120000Z/postgres/succeeding_db.dump.age"]);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("attempts all databases and delivers surviving databases even when destination delivery fails for one", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "main-pg-test-"));
    const fixedNow = new Date("2026-10-25T12:00:00Z");

    const fakeExec = (async (cmd: string, args: readonly string[]) => {
      if (cmd === "psql") {
        return { stdout: "db1\ndb2\n", stderr: "" };
      }
      if (cmd === "pg_dump") {
        const fileArg = args.find((a) => a.startsWith("--file="));
        const filePath = fileArg!.replace("--file=", "");
        await writeFile(filePath, Buffer.from("valid dump payload"));
        return { stdout: "", stderr: "" };
      }
      if (cmd === "pg_restore") {
        return { stdout: "1234; TOC line\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    }) as unknown as ExecFileFn;

    const deliveredKeys: string[] = [];
    const mockDestination: Destination = {
      id: "r2",
      deliver: async (_archivePath, objectKey) => {
        if (objectKey.includes("db1")) {
          throw new Error("R2 upload timeout");
        }
        deliveredKeys.push(objectKey);
        return { location: `s3://bucket/${objectKey}`, bytes: 42, sha256: "mocksha" };
      },
      prune: async () => [],
    };

    const fakeEncrypt: typeof encryptArchive = async (_config, inputPath) => {
      const encPath = `${inputPath}.age`;
      await writeFile(encPath, Buffer.from("encrypted age content"));
      return { encryptedPath: encPath, bytes: 42 };
    };

    try {
      await expect(
        runPostgresBackup(testConfig, [mockDestination], workDir, {
          now: fixedNow,
          exec: fakeExec,
          encrypt: fakeEncrypt,
          writeSummary: async () => {},
        }),
      ).rejects.toThrowError(/One or more databases failed to back up: db1: One or more destinations failed: r2 \(delivery\): R2 upload timeout/);

      // Verify db2 was still delivered!
      expect(deliveredKeys).toEqual(["backups/2026-10-25T120000Z/postgres/db2.dump.age"]);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("fails loudly when zero candidate databases are discovered", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "main-pg-test-"));
    const fakeExec = (async (cmd: string) => {
      if (cmd === "psql") {
        return { stdout: "   \n\n  ", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    }) as unknown as ExecFileFn;

    try {
      await expect(
        runPostgresBackup(testConfig, [], workDir, {
          exec: fakeExec,
        }),
      ).rejects.toThrowError(/no databases to back up/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("skips databases matching PG_DB_BLOCKLIST glob patterns (supports * wildcards)", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "main-pg-test-"));
    const fixedNow = new Date("2026-10-25T12:00:00Z");

    const dumpedDbs: string[] = [];
    const fakeExec = (async (cmd: string, args: readonly string[]) => {
      if (cmd === "psql") {
        return {
          stdout: ["postgres", "app_prod", "app_test", "prisma_migrate_shadow_db_1234", "prisma_migrate_shadow_db_5678"].join("\n"),
          stderr: "",
        };
      }
      if (cmd === "pg_dump") {
        const dbArg = args.find((_, i) => args[i - 1] === "--dbname" || args[i - 1] === "-d");
        if (dbArg) dumpedDbs.push(dbArg);
        const fileArg = args.find((a) => a.startsWith("--file="));
        const filePath = fileArg!.replace("--file=", "");
        await writeFile(filePath, Buffer.from("valid dump payload"));
        return { stdout: "", stderr: "" };
      }
      if (cmd === "pg_restore") {
        return { stdout: "1234; TOC line\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    }) as unknown as ExecFileFn;

    const deliveredKeys: string[] = [];
    const mockDestination: Destination = {
      id: "local",
      deliver: async (_archivePath, objectKey) => {
        deliveredKeys.push(objectKey);
        return { location: `/dest/${objectKey}`, bytes: 42, sha256: "mocksha" };
      },
      prune: async () => [],
    };

    const fakeEncrypt: typeof encryptArchive = async (_config, inputPath) => {
      const encPath = `${inputPath}.age`;
      await writeFile(encPath, Buffer.from("encrypted age content"));
      return { encryptedPath: encPath, bytes: 42 };
    };

    const blocklistConfig: PostgresConfig = {
      ...testConfig,
      PG_DB_BLOCKLIST: ["prisma_migrate_shadow_db_*", "*_test"],
    };

    try {
      await runPostgresBackup(blocklistConfig, [mockDestination], workDir, {
        now: fixedNow,
        exec: fakeExec,
        encrypt: fakeEncrypt,
        writeSummary: async () => {},
      });

      // postgres and app_prod are allowed; prisma shadow dbs and app_test are skipped
      expect(dumpedDbs).toEqual([
        "postgresql://backup-user@db.internal:5432/postgres?sslmode=require",
        "postgresql://backup-user@db.internal:5432/app_prod?sslmode=require",
      ]);
      expect(deliveredKeys).toEqual([
        "backups/2026-10-25T120000Z/postgres/postgres.dump.age",
        "backups/2026-10-25T120000Z/postgres/app_prod.dump.age",
      ]);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("fails loudly when all discovered databases are excluded by PG_DB_BLOCKLIST", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "main-pg-test-"));
    const fakeExec = (async (cmd: string) => {
      if (cmd === "psql") {
        return { stdout: "test_db1\ntest_db2\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    }) as unknown as ExecFileFn;

    const blocklistConfig: PostgresConfig = {
      ...testConfig,
      PG_DB_BLOCKLIST: ["test_*"],
    };

    try {
      await expect(
        runPostgresBackup(blocklistConfig, [], workDir, {
          exec: fakeExec,
        }),
      ).rejects.toThrowError(/No databases to back up after applying PG_DB_BLOCKLIST/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

const testMongoConfig: MongodbConfig = {
  ENGINE: "mongodb",
  MONGODB_URI: "mongodb://localhost:27017/admin",
  AGE_RECIPIENT: "age1mock",
  LOG_LEVEL: "fatal",
  RETENTION_DAYS: 30,
  BACKUP_PREFIX: "backups/",
  DUMP_TIMEOUT_MS: 5000,
  TOOL_CHECK_TIMEOUT_MS: 1000,
  MAX_BUFFER: 1024 * 1024,
  DESTINATIONS: ["local"],
};

describe("runMongodbBackup flow", () => {
  it("runs cluster-wide dump when MONGODB_DB_BLOCKLIST is not configured", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "main-mongo-test-"));
    const fixedNow = new Date("2026-10-25T12:00:00Z");

    const mongodumpCalls: Array<{ cmd: string; args: readonly string[] }> = [];
    const fakeExec = (async (cmd: string, args: readonly string[]) => {
      mongodumpCalls.push({ cmd, args });
      if (cmd === "mongodump") {
        const fileArg = args.find((a) => a.startsWith("--archive="));
        const filePath = fileArg!.replace("--archive=", "");
        await writeFile(filePath, Buffer.from("valid mongo archive"));
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    }) as unknown as ExecFileFn;

    const deliveredKeys: string[] = [];
    const mockDestination: Destination = {
      id: "local",
      deliver: async (_archivePath, objectKey) => {
        deliveredKeys.push(objectKey);
        return { location: `/dest/${objectKey}`, bytes: 42, sha256: "mocksha" };
      },
      prune: async () => [],
    };

    const fakeEncrypt: typeof encryptArchive = async (_config, inputPath) => {
      const encPath = `${inputPath}.age`;
      await writeFile(encPath, Buffer.from("encrypted age content"));
      return { encryptedPath: encPath, bytes: 42 };
    };

    try {
      await runMongodbBackup(testMongoConfig, [mockDestination], workDir, {
        now: fixedNow,
        exec: fakeExec,
        encrypt: fakeEncrypt,
        writeSummary: async () => {},
      });

      // Cluster-wide dump includes --oplog and has no --db argument
      expect(mongodumpCalls).toHaveLength(1);
      expect(mongodumpCalls[0].args).toContain("--oplog");
      expect(mongodumpCalls[0].args.some((a) => a.startsWith("--db="))).toBe(false);
      expect(deliveredKeys).toEqual(["backups/2026-10-25T120000Z/mongodb/mongodb.archive.gz.age"]);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("enumerates databases and dumps allowed databases when MONGODB_DB_BLOCKLIST is set", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "main-mongo-test-"));
    const fixedNow = new Date("2026-10-25T12:00:00Z");

    const mongodumpCalls: Array<{ cmd: string; args: readonly string[] }> = [];
    const fakeExec = (async (cmd: string, args: readonly string[]) => {
      mongodumpCalls.push({ cmd, args });
      if (cmd === "mongodump") {
        const fileArg = args.find((a) => a.startsWith("--archive="));
        const filePath = fileArg!.replace("--archive=", "");
        await writeFile(filePath, Buffer.from("valid mongo archive"));
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    }) as unknown as ExecFileFn;

    const deliveredKeys: string[] = [];
    const mockDestination: Destination = {
      id: "local",
      deliver: async (_archivePath, objectKey) => {
        deliveredKeys.push(objectKey);
        return { location: `/dest/${objectKey}`, bytes: 42, sha256: "mocksha" };
      },
      prune: async () => [],
    };

    const fakeEncrypt: typeof encryptArchive = async (_config, inputPath) => {
      const encPath = `${inputPath}.age`;
      await writeFile(encPath, Buffer.from("encrypted age content"));
      return { encryptedPath: encPath, bytes: 42 };
    };

    const blocklistConfig: MongodbConfig = {
      ...testMongoConfig,
      MONGODB_DB_BLOCKLIST: ["prisma_migrate_shadow_db_*", "*_test"],
    };

    const fakeEnumerate = async () => ["users_prod", "orders_prod", "temp_test", "prisma_migrate_shadow_db_abc"];

    try {
      await runMongodbBackup(blocklistConfig, [mockDestination], workDir, {
        now: fixedNow,
        exec: fakeExec,
        encrypt: fakeEncrypt,
        writeSummary: async () => {},
        enumerateMongodbDbs: fakeEnumerate,
      });

      // users_prod and orders_prod dumped with --db and without --oplog
      expect(mongodumpCalls).toHaveLength(2);
      expect(mongodumpCalls[0].args).toContain("--db=users_prod");
      expect(mongodumpCalls[0].args).not.toContain("--oplog");
      expect(mongodumpCalls[1].args).toContain("--db=orders_prod");
      expect(mongodumpCalls[1].args).not.toContain("--oplog");

      expect(deliveredKeys).toEqual([
        "backups/2026-10-25T120000Z/mongodb/users_prod.archive.gz.age",
        "backups/2026-10-25T120000Z/mongodb/orders_prod.archive.gz.age",
      ]);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("fails loudly when all discovered MongoDB databases are excluded by MONGODB_DB_BLOCKLIST", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "main-mongo-test-"));
    const blocklistConfig: MongodbConfig = {
      ...testMongoConfig,
      MONGODB_DB_BLOCKLIST: ["scratch_*"],
    };

    try {
      await expect(
        runMongodbBackup(blocklistConfig, [], workDir, {
          enumerateMongodbDbs: async () => ["scratch_1", "scratch_2"],
        }),
      ).rejects.toThrowError(/No databases to back up after applying MONGODB_DB_BLOCKLIST/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
