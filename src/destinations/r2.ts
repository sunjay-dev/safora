import type { Config } from "../config/env.config.js";
import { buildS3Client } from "../storage/client.js";
import { pruneExpiredBackups } from "../storage/retention.js";
import { uploadAndVerify } from "../storage/upload.js";
import type { DeliveryResult, Destination } from "./destination.js";

/** The R2 bucket destination: the original delivery-and-retention pipeline behind the contract. */
export function createR2Destination(config: Config): Destination {
  const client = buildS3Client(config);

  return {
    id: "r2",
    async deliver(archivePath, objectKey): Promise<DeliveryResult> {
      const { bytes, sha256 } = await uploadAndVerify(config, client, archivePath, objectKey);
      return { location: `s3://${config.R2_BUCKET}/${objectKey}`, bytes, sha256 };
    },
    prune(currentObjectKey) {
      return pruneExpiredBackups(config, client, currentObjectKey);
    },
  };
}
