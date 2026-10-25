import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import type { Config } from "../config/env.config.js";
import { retentionCutoff, selectKeysToDelete, type RetentionCandidate } from "./retention-policy.js";

/** Delete objects under backups/ whose LastModified is older than RETENTION_DAYS. */
export async function pruneExpiredBackups(
  config: Config,
  client: S3Client,
  currentKey: string,
): Promise<string[]> {
  const cutoff = retentionCutoff(config.RETENTION_DAYS);
  const candidates: RetentionCandidate[] = [];
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
      if (!object.Key || !object.LastModified) continue;
      candidates.push({ key: object.Key, modifiedAt: object.LastModified });
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  const toDelete = selectKeysToDelete(candidates, cutoff, currentKey);

  // S3 batch delete accepts up to 1000 objects per request.
  for (let i = 0; i < toDelete.length; i += 1000) {
    await client.send(
      new DeleteObjectsCommand({
        Bucket: config.R2_BUCKET,
        Delete: {
          Objects: toDelete.slice(i, i + 1000).map((key) => ({ Key: key })),
          Quiet: true,
        },
      }),
    );
  }
  return toDelete;
}
