/** e.g. 2026-10-24T021715Z — lexicographically sortable, safe in an S3 key. */
export function objectTimestamp(date = new Date()): string {
  return `${date.toISOString().slice(0, 19).replace(/:/g, "")}Z`;
}

/** The archive's object key within a destination: prefix + timestamped name. */
export function archiveObjectKey(prefix: string, date: Date): string {
  return `${prefix}mongodb-${objectTimestamp(date)}.archive.gz.age`;
}

/** A finished archive's file name — never a `.part` staging file or a foreign file. */
export function isArchiveFileName(name: string): boolean {
  return /^mongodb-\d{4}-\d{2}-\d{2}T\d{6}Z\.archive\.gz\.age$/.test(name);
}

export function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
