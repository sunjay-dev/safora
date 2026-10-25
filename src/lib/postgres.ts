import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fail } from "../logging.js";

export interface SplitPostgresUriResult {
  connectionArgs: string[];
  pgpassEntry?: string;
  strippedUri: string;
  password?: string;
}

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
    const rawPath = url.pathname.replace(/^\//, "");
    const database = rawPath !== "" ? decodeURIComponent(rawPath) : "*";
    const rawUser = url.username;
    const username = rawUser !== "" ? decodeURIComponent(rawUser) : "*";

    pgpassEntry = `${escapePgpassField(hostname)}:${escapePgpassField(port)}:${escapePgpassField(database)}:${escapePgpassField(username)}:${escapePgpassField(password)}`;
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
