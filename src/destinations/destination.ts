/** The result of writing an archive to a destination and verifying the written copy. */
export interface DeliveryResult {
  /** Human-readable location of the archive within the destination. */
  location: string;
  bytes: number;
  sha256: string;
}

/** A place a run delivers its archive; the one seam every destination implements. */
export interface Destination {
  /** Stable identifier used in configuration, logs, and summaries, e.g. "r2". */
  readonly id: string;

  /** Write the archive at the given object key, verify it, and report what landed. */
  deliver(archivePath: string, objectKey: string): Promise<DeliveryResult>;

  /** Apply retention, returning the pruned object keys; never prunes the current run's key. */
  prune(currentObjectKey: string): Promise<string[]>;
}
