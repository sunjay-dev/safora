export interface RetentionCandidate {
  /** The archive's object key within its destination. */
  key: string;
  /** Last modification time. */
  modifiedAt: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The instant before which archives are expired, for one global retention window. */
export function retentionCutoff(retentionDays: number, now = Date.now()): Date {
  return new Date(now - retentionDays * DAY_MS);
}

/** Keys past retention: older than the cutoff, excluding the run's own archive. */
export function selectKeysToDelete(items: readonly RetentionCandidate[], cutoff: Date, currentKey: string): string[] {
  return items
    .filter((item) => item.key !== currentKey && item.modifiedAt.getTime() < cutoff.getTime())
    .map((item) => item.key);
}
