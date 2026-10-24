import { S3Client } from "@aws-sdk/client-s3";
import type { Config } from "../config/env.config.js";

/** S3-compatible client pointed at the account's R2 endpoint. */
export function buildS3Client(config: Config): S3Client {
  return new S3Client({
    region: "auto", // R2's required region value
    endpoint: config.R2_ENDPOINT,
    credentials: {
      accessKeyId: config.R2_ACCESS_KEY_ID,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY,
    },
  });
}
