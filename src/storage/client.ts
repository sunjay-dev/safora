import { S3Client } from "@aws-sdk/client-s3";
import type { Config } from "../config.js";

/** S3-compatible client pointed at the account's R2 endpoint. */
export function buildS3Client(config: Config): S3Client {
  return new S3Client({
    region: "auto", // R2's required region value
    endpoint: `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.R2_ACCESS_KEY_ID,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY,
    },
  });
}
