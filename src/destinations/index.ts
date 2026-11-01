import type { Config, DestinationId } from "../config/env.config.js";
import type { Destination } from "./destination.js";
import { createLocalDestination } from "./local.js";
import { createR2Destination } from "./r2.js";

/** The destinations selected for this run, in delivery order. */
export function buildDestinations(config: Config): Destination[] {
  return config.DESTINATIONS.map((id) => createDestination(id, config));
}

function createDestination(id: DestinationId, config: Config): Destination {
  switch (id) {
    case "s3":
      return createR2Destination(config);
    case "local":
      return createLocalDestination(config);
  }
}
