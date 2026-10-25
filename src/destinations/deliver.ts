import { logger, sanitize } from "../logging.js";
import type { DeliveryResult, Destination } from "./destination.js";

/** Which destination operation failed. */
export type DestinationFailureStage = "delivery" | "retention";

/** A failed destination operation, with the detail sanitized for reporting. */
export interface DestinationFailure {
  stage: DestinationFailureStage;
  message: string;
}

/** What happened for one destination during a run. */
export interface DestinationOutcome {
  id: string;
  /** Present when delivery succeeded, even if retention later failed. */
  delivery: DeliveryResult | null;
  /** Keys pruned by this destination; empty when retention failed. */
  pruned: string[];
  /** Present when delivery or retention failed. */
  failure: DestinationFailure | null;
}

export interface FailedDestinationOutcome extends DestinationOutcome {
  failure: DestinationFailure;
}

/** The outcomes whose delivery or retention failed. */
export function failedOutcomes(outcomes: readonly DestinationOutcome[]): FailedDestinationOutcome[] {
  return outcomes.filter((outcome): outcome is FailedDestinationOutcome => outcome.failure !== null);
}

/**
 * Deliver to every destination in listed order. Every destination is attempted
 * even when an earlier one fails, and retention runs only after that
 * destination's own successful delivery. Failures are collected, not thrown.
 */
export async function deliverArchive(destinations: readonly Destination[], archivePath: string, objectKey: string): Promise<DestinationOutcome[]> {
  const outcomes: DestinationOutcome[] = [];

  for (const destination of destinations) {
    let delivery: DeliveryResult;
    try {
      delivery = await destination.deliver(archivePath, objectKey);
    } catch (err) {
      const failure = toFailure("delivery", err);
      logger.error({ destination: destination.id, detail: failure.message }, "delivery failed");
      outcomes.push({ id: destination.id, delivery: null, pruned: [], failure });
      continue;
    }

    logger.info(
      {
        destination: destination.id,
        location: delivery.location,
        bytes: delivery.bytes,
        sha256: delivery.sha256,
      },
      "delivery verified",
    );

    try {
      const pruned = await destination.prune(objectKey);
      logger.info({ destination: destination.id, pruned: pruned.length, keys: pruned }, "retention policy applied");
      outcomes.push({ id: destination.id, delivery, pruned, failure: null });
    } catch (err) {
      const failure = toFailure("retention", err);
      logger.error({ destination: destination.id, detail: failure.message }, "retention failed");
      outcomes.push({ id: destination.id, delivery, pruned: [], failure });
    }
  }

  return outcomes;
}

function toFailure(stage: DestinationFailureStage, err: unknown): DestinationFailure {
  return { stage, message: sanitize(errorMessage(err)) };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
