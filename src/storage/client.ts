import { S3Client } from "@aws-sdk/client-s3";
import type { Config } from "../config/env.config.js";

/** S3-compatible client factory. */
export function buildS3Client(config: Config): S3Client {
  return new S3Client({
    ...(config.S3_REGION !== undefined ? { region: config.S3_REGION } : {}),
    ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
    ...(config.S3_FORCE_PATH_STYLE !== undefined ? { forcePathStyle: config.S3_FORCE_PATH_STYLE } : {}),
    ...(config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: config.S3_ACCESS_KEY_ID,
            secretAccessKey: config.S3_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });
}
