import type { Config } from "../config/env.config.js";
import type { Destination } from "./destination.js";
import { createS3Destination, type S3DestinationOptions } from "./s3.js";

/**
 * Backward-compatible adapter for legacy R2 destination setups.
 * Delegates directly to createS3Destination.
 */
export function createR2Destination(config: Config, options?: S3DestinationOptions): Destination {
  return createS3Destination(config, options);
}

export { createS3Destination };
