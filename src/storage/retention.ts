import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import type { Config } from "../config/env.config.js";

/** Delete objects under backups/ whose LastModified is older than RETENTION_DAYS. */
export async function pruneExpiredBackups(
  config: Config,
  client: S3Client,
  currentKey: string,
): Promise<string[]> {
  const cutoffMs = Date.now() - config.RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const expired: { Key: string }[] = [];
  let continuationToken: string | undefined;

  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: config.R2_BUCKET,
        Prefix: config.BACKUP_PREFIX,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of page.Contents ?? []) {
      const lastModified = object.LastModified?.getTime();
      if (!object.Key || object.Key === currentKey || lastModified === undefined) continue;
      if (lastModified < cutoffMs) expired.push({ Key: object.Key });
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  // S3 batch delete accepts up to 1000 objects per request.
  for (let i = 0; i < expired.length; i += 1000) {
    await client.send(
      new DeleteObjectsCommand({
        Bucket: config.R2_BUCKET,
        Delete: { Objects: expired.slice(i, i + 1000), Quiet: true },
      }),
    );
  }
  return expired.map((object) => object.Key);
}
