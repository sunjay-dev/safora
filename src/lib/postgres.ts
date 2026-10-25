import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fail } from "../logging.js";

export interface SplitPostgresUriResult {
  connectionArgs: string[];
  pgpassEntry?: string;
  strippedUri: string;
  password?: string;
}

export const ENUMERATE_DATABASES_QUERY = "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate";

/**
 * Escapes characters for .pgpass entry format.
 * In .pgpass, `:` and `\` in fields must be escaped with a backslash.
 */
function escapePgpassField(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

/**
 * Splits a PostgreSQL connection URI into connection arguments (password stripped)
 * and an optional PGPASSFILE entry.
 *
 * Honors the URI verbatim (including sslmode and query parameters).
 * Handles URL-encoded passwords, explicit ports, and password-less URIs.
 * The PGPASSFILE entry uses the database wildcard `*` so that a single entry
 * covers all enumerated databases on the server.
 */
export function splitPostgresUri(uri: string): SplitPostgresUriResult {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    fail("POSTGRESQL_URI must be a valid PostgreSQL connection URI (postgres:// or postgresql://)");
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    fail("POSTGRESQL_URI must be a valid PostgreSQL connection URI (postgres:// or postgresql://)");
  }

  const rawPassword = url.password;
  const password = rawPassword !== "" ? decodeURIComponent(rawPassword) : undefined;

  let pgpassEntry: string | undefined;
  if (password !== undefined) {
    const rawHost = url.hostname;
    const hostname = rawHost !== "" ? rawHost : "*";
    const port = url.port !== "" ? url.port : "5432";
    const database = "*";
    const rawUser = url.username;
    const username = rawUser !== "" ? decodeURIComponent(rawUser) : "*";

    pgpassEntry = `${escapePgpassField(hostname)}:${escapePgpassField(port)}:${database}:${escapePgpassField(username)}:${escapePgpassField(password)}`;
  }

  // Strip password from the URI
  url.password = "";
  const strippedUri = url.toString();
  const connectionArgs = ["--dbname", strippedUri];

  return {
    connectionArgs,
    pgpassEntry,
    strippedUri,
    password,
  };
}

/**
 * Builds a connection URI targeting a specific database by replacing the pathname
 * in the stripped base URI while preserving all other connection parameters verbatim.
 */
export function buildDatabaseUri(strippedUri: string, database: string): string {
  const url = new URL(strippedUri);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

/**
 * Builds connection arguments targeting a specific database with the password stripped.
 */
export function buildDatabaseConnectionArgs(strippedUri: string, database: string): string[] {
  return ["--dbname", buildDatabaseUri(strippedUri, database)];
}

/**
 * Builds arguments for `psql` to execute a single query cleanly without headers or alignment.
 */
export function buildPsqlArgs(connectionArgs: readonly string[], query: string): string[] {
  return [...connectionArgs, "--no-align", "--tuples-only", "--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-c", query];
}

/**
 * Parses database names from `psql --no-align --tuples-only` stdout.
 */
export function parseDatabaseList(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Builds arguments for `pg_dump --format=custom`.
 * The connection arguments contain the stripped URI, so passwords never reach the command line.
 */
export function buildPgDumpArgs(connectionArgs: readonly string[], archivePath: string): string[] {
  return [...connectionArgs, "--format=custom", `--file=${archivePath}`];
}

/**
 * Builds arguments for `pg_restore --list`.
 */
export function buildPgRestoreArgs(archivePath: string): string[] {
  return ["--list", archivePath];
}

/**
 * Manages the lifecycle of a temporary 0600-mode PGPASSFILE.
 * Deletes the file after completion or failure.
 */
export async function withPgpassFile<T>(
  workDir: string,
  pgpassEntry: string | undefined,
  fn: (pgpassPath: string | undefined) => Promise<T>,
): Promise<T> {
  if (!pgpassEntry) {
    return fn(undefined);
  }

  const pgpassPath = join(workDir, ".pgpass");
  await writeFile(pgpassPath, `${pgpassEntry}\n`, { mode: 0o600 });
  await chmod(pgpassPath, 0o600);

  try {
    return await fn(pgpassPath);
  } finally {
    await rm(pgpassPath, { force: true });
  }
}
