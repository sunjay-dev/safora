import { S3Client } from "@aws-sdk/client-s3";
import type { Config } from "../config/env.config.js";

function resolveRegion(config: Config): string | undefined {
  if (config.S3_REGION) {
    return config.S3_REGION;
  }
  if (config.S3_ENDPOINT) {
    try {
      const url = new URL(config.S3_ENDPOINT);
      if (url.hostname.endsWith(".r2.cloudflarestorage.com") || url.hostname === "r2.cloudflarestorage.com") {
        return "auto";
      }
    } catch {
      // ignore
    }
  }
  return undefined;
}

/** S3-compatible client factory. */
export function buildS3Client(config: Config): S3Client {
  const region = resolveRegion(config);

  return new S3Client({
    ...(region !== undefined ? { region } : {}),
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
