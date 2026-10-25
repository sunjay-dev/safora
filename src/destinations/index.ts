import type { Config } from "../config/env.config.js";
import type { Destination } from "./destination.js";
import { createR2Destination } from "./r2.js";

/**
 * The destinations selected for this run, in delivery order. R2 only for now;
 * the explicit DESTINATIONS list arrives with the config ticket.
 */
export function buildDestinations(config: Config): Destination[] {
  return [createR2Destination(config)];
}
