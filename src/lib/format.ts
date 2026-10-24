/** e.g. 2026-10-24T021715Z — lexicographically sortable, safe in an S3 key. */
export function objectTimestamp(date = new Date()): string {
  return `${date.toISOString().slice(0, 19).replace(/:/g, "")}Z`;
}

export function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
