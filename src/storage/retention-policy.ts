export interface RetentionCandidate {
  /** The archive's object key within its destination. */
  key: string;
  /** Last modification time. */
  modifiedAt: Date;
}

/** Keys past retention: older than the cutoff, excluding the run's own archive. */
export function selectKeysToDelete(items: readonly RetentionCandidate[], cutoff: Date, currentKey: string): string[] {
  return items
    .filter((item) => item.key !== currentKey && item.modifiedAt.getTime() < cutoff.getTime())
    .map((item) => item.key);
}
