import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENUMERATE_DATABASES_QUERY,
  buildDatabaseConnectionArgs,
  buildDatabaseUri,
  buildPgDumpArgs,
  buildPgRestoreArgs,
  buildPsqlArgs,
  parseDatabaseList,
  splitPostgresUri,
  withPgpassFile,
} from "./postgres.js";

describe("splitPostgresUri", () => {
  it("splits a standard PostgreSQL URI into connection arguments and a wildcard PGPASSFILE entry", () => {
    const uri = "postgresql://backup-user:secret123@db.internal:5433/postgres?sslmode=verify-full";
    const result = splitPostgresUri(uri);

    expect(result.password).toBe("secret123");
    // Database field must be wildcard '*' to cover all enumerated databases on the host
    expect(result.pgpassEntry).toBe("db.internal:5433:*:backup-user:secret123");
    expect(result.strippedUri).toBe("postgresql://backup-user@db.internal:5433/postgres?sslmode=verify-full");
    expect(result.connectionArgs).toEqual(["--dbname", "postgresql://backup-user@db.internal:5433/postgres?sslmode=verify-full"]);
  });

  it("handles postgres:// scheme and defaults omitted port to 5432 with wildcard in pgpass", () => {
    const uri = "postgres://backup-user:secret123@db.internal/postgres";
    const result = splitPostgresUri(uri);

    expect(result.password).toBe("secret123");
    expect(result.pgpassEntry).toBe("db.internal:5432:*:backup-user:secret123");
    expect(result.strippedUri).toBe("postgres://backup-user@db.internal/postgres");
    expect(result.connectionArgs).toEqual(["--dbname", "postgres://backup-user@db.internal/postgres"]);
  });

  it("decodes URL-encoded passwords and handles special characters in pgpass format", () => {
    // Password contains @ and /, encoded as %40 and %2F
    const uri = "postgres://backup-user:p%40ss%2Fword@db.internal/postgres";
    const result = splitPostgresUri(uri);

    expect(result.password).toBe("p@ss/word");
    expect(result.pgpassEntry).toBe("db.internal:5432:*:backup-user:p@ss/word");
  });

  it("escapes colons and backslashes in user and password for pgpass entry with wildcard database", () => {
    // user:1 (encoded as user%3A1), password p@ss:w\ord (encoded as p%40ss%3Aw%5Cord)
    const uri = "postgresql://user%3A1:p%40ss%3Aw%5Cord@db.example.com:5432/postgres";
    const result = splitPostgresUri(uri);

    expect(result.password).toBe("p@ss:w\\ord");
    // In pgpass: colons and backslashes must be escaped with \
    expect(result.pgpassEntry).toBe("db.example.com:5432:*:user\\:1:p@ss\\:w\\\\ord");
  });

  it("handles password-less URIs with a username", () => {
    const uri = "postgresql://backup-user@db.internal:5432/postgres?sslmode=require";
    const result = splitPostgresUri(uri);

    expect(result.password).toBeUndefined();
    expect(result.pgpassEntry).toBeUndefined();
    expect(result.strippedUri).toBe("postgresql://backup-user@db.internal:5432/postgres?sslmode=require");
    expect(result.connectionArgs).toEqual(["--dbname", "postgresql://backup-user@db.internal:5432/postgres?sslmode=require"]);
  });

  it("handles password-less URIs without a username", () => {
    const uri = "postgresql://db.internal:5432/postgres";
    const result = splitPostgresUri(uri);

    expect(result.password).toBeUndefined();
    expect(result.pgpassEntry).toBeUndefined();
    expect(result.strippedUri).toBe("postgresql://db.internal:5432/postgres");
    expect(result.connectionArgs).toEqual(["--dbname", "postgresql://db.internal:5432/postgres"]);
  });

  it("rejects an invalid URI without echoing the raw URI", () => {
    const invalidUri = "postgresql://backup-user:super-secret@[broken-host/app";
    expect(() => splitPostgresUri(invalidUri)).toThrowError(/POSTGRESQL_URI must be a valid PostgreSQL connection URI/);
    try {
      splitPostgresUri(invalidUri);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain("super-secret");
      expect(msg).not.toContain(invalidUri);
    }
  });

  it("rejects a non-postgres scheme", () => {
    expect(() => splitPostgresUri("mysql://user:pass@host/db")).toThrowError(/POSTGRESQL_URI must be a valid PostgreSQL connection URI/);
  });
});

describe("buildDatabaseUri and buildDatabaseConnectionArgs", () => {
  it("targets the specified database while preserving all other connection parameters", () => {
    const strippedUri = "postgresql://backup-user@db.internal:5432/postgres?sslmode=require&connect_timeout=10";
    const dbUri = buildDatabaseUri(strippedUri, "orders_db");

    expect(dbUri).toBe("postgresql://backup-user@db.internal:5432/orders_db?sslmode=require&connect_timeout=10");
    expect(buildDatabaseConnectionArgs(strippedUri, "orders_db")).toEqual(["--dbname", dbUri]);
  });

  it("encodes database names with special characters safely in the URI path", () => {
    const strippedUri = "postgresql://backup-user@db.internal:5432/postgres";
    const dbUri = buildDatabaseUri(strippedUri, "my/db@special");

    expect(dbUri).toBe("postgresql://backup-user@db.internal:5432/my%2Fdb%40special");
  });
});

describe("buildPsqlArgs and parseDatabaseList", () => {
  it("assembles psql arguments for database enumeration without passwords", () => {
    const password = "super-secret-password-xyz";
    const uri = `postgresql://backup-user:${password}@db.internal:5432/postgres?sslmode=require`;
    const { connectionArgs } = splitPostgresUri(uri);
    const args = buildPsqlArgs(connectionArgs, ENUMERATE_DATABASES_QUERY);

    expect(args).toContain("--no-align");
    expect(args).toContain("--tuples-only");
    expect(args).toContain("--no-psqlrc");
    expect(args).toContain("-v");
    expect(args).toContain("ON_ERROR_STOP=1");
    expect(args).toContain("-c");
    expect(args).toContain(ENUMERATE_DATABASES_QUERY);
    expect(args).toContain("--dbname");
    // Explicitly verify the query filters templates and non-connectable databases
    expect(ENUMERATE_DATABASES_QUERY).toContain("datallowconn");
    expect(ENUMERATE_DATABASES_QUERY).toContain("NOT datistemplate");

    // Content-asserted: password must not appear anywhere in args
    for (const arg of args) {
      expect(arg).not.toContain(password);
    }
    expect(args.join(" ")).not.toContain(password);
  });

  it("parses database list output from psql, ignoring blank lines and trimming whitespace", () => {
    const stdout = "  postgres  \n\n  app_production \n  analytics_reporting\n\n";
    const databases = parseDatabaseList(stdout);

    expect(databases).toEqual(["postgres", "app_production", "analytics_reporting"]);
  });

  it("returns an empty array when stdout contains no database names", () => {
    expect(parseDatabaseList("")).toEqual([]);
    expect(parseDatabaseList("   \n\n  \t  ")).toEqual([]);
  });
});

describe("buildPgDumpArgs and buildPgRestoreArgs security invariants", () => {
  it("assembled pg_dump arguments never contain the password", () => {
    const password = "super-sensitive-password!#123";
    const encodedPassword = encodeURIComponent(password);
    const uri = `postgresql://backup-user:${encodedPassword}@db.internal:5433/postgres?sslmode=require`;

    const { strippedUri } = splitPostgresUri(uri);
    const connectionArgs = buildDatabaseConnectionArgs(strippedUri, "app_db");
    const archivePath = "/tmp/backup-workspace/postgres-app_db.dump";
    const args = buildPgDumpArgs(connectionArgs, archivePath);

    // Assert that the password is not anywhere in args
    for (const arg of args) {
      expect(arg).not.toContain(password);
      expect(arg).not.toContain(encodedPassword);
    }
    expect(args.join(" ")).not.toContain(password);
    expect(args.join(" ")).not.toContain(encodedPassword);

    // Assert expected flags and per-database target URI
    expect(args).toContain("--format=custom");
    expect(args).toContain(`--file=${archivePath}`);
    expect(args).toContain("--dbname");
    expect(args).toContain("postgresql://backup-user@db.internal:5433/app_db?sslmode=require");
  });

  it("assembled pg_restore arguments list the TOC of the archive", () => {
    const archivePath = "/tmp/backup-workspace/postgres-app_db.dump";
    const args = buildPgRestoreArgs(archivePath);

    expect(args).toEqual(["--list", archivePath]);
  });
});

describe("withPgpassFile lifecycle against real filesystem", () => {
  it("creates a 0600 mode PGPASSFILE with the exact entry and deletes it after completion", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pgpass-test-"));
    const entry = "db.internal:5432:*:backup-user:secret123";

    let observedPath: string | undefined;
    await withPgpassFile(workDir, entry, async (pgpassPath) => {
      observedPath = pgpassPath;
      expect(pgpassPath).toBeDefined();
      expect(existsSync(pgpassPath!)).toBe(true);

      // Verify file permissions are 0600 (owner read/write only).
      // NTFS has no Unix permission bits — writeFile's mode is a no-op on
      // Windows and stat always reports 0666, so assert only on POSIX.
      if (process.platform !== "win32") {
        const fileStat = await stat(pgpassPath!);
        expect(fileStat.mode & 0o777).toBe(0o600);
      }

      // Verify file content is exactly the entry followed by a newline
      const content = await readFile(pgpassPath!, "utf8");
      expect(content).toBe(`${entry}\n`);
    });

    // Verify deleted after block completes
    expect(observedPath).toBeDefined();
    expect(existsSync(observedPath!)).toBe(false);

    await rm(workDir, { recursive: true, force: true });
  });

  it("deletes the PGPASSFILE even when the enclosed function throws an error (simulated failure)", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pgpass-test-"));
    const entry = "db.internal:5432:*:backup-user:secret123";

    let observedPath: string | undefined;
    await expect(
      withPgpassFile(workDir, entry, async (pgpassPath) => {
        observedPath = pgpassPath;
        expect(existsSync(pgpassPath!)).toBe(true);
        throw new Error("simulated dump failure");
      }),
    ).rejects.toThrow("simulated dump failure");

    // Verify deleted after failure
    expect(observedPath).toBeDefined();
    expect(existsSync(observedPath!)).toBe(false);

    await rm(workDir, { recursive: true, force: true });
  });

  it("does not create a file when pgpassEntry is undefined (password-less)", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pgpass-test-"));

    await withPgpassFile(workDir, undefined, async (pgpassPath) => {
      expect(pgpassPath).toBeUndefined();
    });

    // No files in workDir
    const expectedPgpass = join(workDir, ".pgpass");
    expect(existsSync(expectedPgpass)).toBe(false);

    await rm(workDir, { recursive: true, force: true });
  });
});
