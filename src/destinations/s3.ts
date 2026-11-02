import type { Config } from "../config/env.config.js";
import { buildS3Client } from "../storage/client.js";
import { pruneExpiredBackups } from "../storage/retention.js";
import { uploadAndVerify } from "../storage/upload.js";
import type { DeliveryResult, Destination } from "./destination.js";

/** The S3/R2 bucket destination: delivery-and-retention pipeline behind the contract. */
export function createS3Destination(config: Config): Destination {
  const client = buildS3Client(config);

  return {
    id: "s3",
    async deliver(archivePath, objectKey): Promise<DeliveryResult> {
      const { bytes, sha256 } = await uploadAndVerify(config, client, archivePath, objectKey);
      return { location: `s3://${config.S3_BUCKET}/${objectKey}`, bytes, sha256 };
    },
    prune(currentObjectKey) {
      return pruneExpiredBackups(config, client, currentObjectKey);
    },
  };
}
