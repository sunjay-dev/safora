import type { EngineId } from "../config/env.config.js";

/** e.g. 2026-10-24T021715Z — lexicographically sortable, safe in an S3 key. */
export function objectTimestamp(date = new Date()): string {
  return `${date.toISOString().slice(0, 19).replace(/:/g, "")}Z`;
}

const archiveFileNameFor = (engine: EngineId, database?: string): string => {
  switch (engine) {
    case "mongodb":
      return database ? `mongodb-${database}.archive.gz.age` : `mongodb.archive.gz.age`;
    case "postgres":
      if (!database) {
        throw new Error("database is required for postgres archive filename");
      }
      return `postgres-${database}.dump.age`;
  }
};

/** The archive's object key within a destination: prefix + timestamp subfolder + clean file name. */
export function archiveObjectKey(prefix: string, engine: "mongodb", date?: Date, database?: string): string;
export function archiveObjectKey(prefix: string, engine: "postgres", date: Date, database: string): string;
export function archiveObjectKey(prefix: string, engine: EngineId, date?: Date, database?: string): string;
export function archiveObjectKey(prefix: string, engine: EngineId, date: Date = new Date(), database?: string): string {
  const timestamp = objectTimestamp(date);
  return `${prefix}${timestamp}/${archiveFileNameFor(engine, database)}`;
}

/** A finished archive's file name — never a `.part` staging file or a foreign file. */
export function isArchiveFileName(name: string): boolean {
  if (name.endsWith(".part") || !name.endsWith(".age")) {
    return false;
  }
  if (name === "mongodb-latest.archive.gz.age") {
    return false;
  }
  if (/^postgres-\d{4}-\d{2}-\d{2}T\d{6}Z\.dump\.age$/.test(name) || name === "postgres.dump.age") {
    return false;
  }
  return /^mongodb(-.+)?(-\d{4}-\d{2}-\d{2}T\d{6}Z)?\.archive\.gz\.age$/.test(name) || /^postgres-.+\.dump\.age$/.test(name);
}

export function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
