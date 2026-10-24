import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Config } from "../config/env.config.js";
import { sha256File } from "../lib/hash.js";
import { fail } from "../logging.js";

/** Multipart-upload the file, then verify via HeadObject that the stored size matches. */
export async function uploadAndVerify(
  config: Config,
  client: S3Client,
  filePath: string,
  objectKey: string,
): Promise<{ bytes: number; sha256: string }> {
  const bytes = (await stat(filePath)).size;
  const sha256 = await sha256File(filePath);

  const upload = new Upload({
    client,
    params: {
      Bucket: config.R2_BUCKET,
      Key: objectKey,
      Body: createReadStream(filePath),
      ContentLength: bytes,
      ContentType: "application/octet-stream",
      Metadata: { "sha-256": sha256 }, // surfaced by R2 as x-amz-meta-sha-256
    },
    partSize: 16 * 1024 * 1024,
    queueSize: 4,
  });
  await upload.done();

  const head = await client.send(
    new HeadObjectCommand({ Bucket: config.R2_BUCKET, Key: objectKey }),
  );
  if (head.ContentLength !== bytes) {
    fail(
      `Upload verification failed: R2 reports ${head.ContentLength ?? "?"} bytes for ${objectKey}, local file is ${bytes}.`,
    );
  }
  return { bytes, sha256 };
}
