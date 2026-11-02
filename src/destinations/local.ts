import { copyFile, mkdir, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Config } from "../config/env.config.js";
import { isArchiveFileName } from "../lib/format.js";
import { sha256File } from "../lib/hash.js";
import { retentionCutoff, selectKeysToDelete, type RetentionCandidate } from "../storage/retention-policy.js";
import type { DeliveryResult, Destination } from "./destination.js";

export interface LocalDestinationOptions {
  /** Fault-injection seam for tests; production uses fs.copyFile to stage the archive. */
  copyFile?: (sourcePath: string, destinationPath: string) => Promise<void>;
}

/** The local-folder destination: the same mirrored layout as S3, written atomically inside one volume. */
export function createLocalDestination(config: Config, options: LocalDestinationOptions = {}): Destination {
  const configuredDir = config.LOCAL_BACKUP_DIR;
  if (!configuredDir) {
    throw new Error("LOCAL_BACKUP_DIR is required for the local destination");
  }

  const root = resolve(configuredDir);
  const copy = options.copyFile ?? copyFile;

  return {
    id: "local",

    async deliver(archivePath, objectKey): Promise<DeliveryResult> {
      const finalPath = resolveObjectPath(root, objectKey);
      const partPath = `${finalPath}.part`;
      await mkdir(dirname(finalPath), { recursive: true });

      const sha256 = await sha256File(archivePath);
      try {
        await copy(archivePath, partPath);
        const copiedSha256 = await sha256File(partPath);
        if (copiedSha256 !== sha256) {
          throw new Error(`Local delivery verification failed for ${objectKey}: expected SHA-256 ${sha256}, copied file has ${copiedSha256}.`);
        }
        await rename(partPath, finalPath);
      } catch (err) {
        await rm(partPath, { force: true }).catch(() => undefined);
        throw err;
      }

      const { size } = await stat(finalPath);
      return { location: finalPath, bytes: size, sha256 };
    },

    prune(currentObjectKey) {
      return pruneLocalArchives(root, config.BACKUP_PREFIX, config.RETENTION_DAYS, currentObjectKey);
    },
  };
}

async function pruneLocalArchives(root: string, prefix: string, retentionDays: number, currentObjectKey: string): Promise<string[]> {
  const cutoff = retentionCutoff(retentionDays);
  const candidates = await collectArchiveCandidates(root, resolveObjectPath(root, prefix));
  const currentKey = objectKeyFor(root, resolveObjectPath(root, currentObjectKey));
  const toDelete = selectKeysToDelete(candidates, cutoff, currentKey);

  const prefixPath = resolveObjectPath(root, prefix);
  for (const key of toDelete) {
    const filePath = resolveObjectPath(root, key);
    await rm(filePath, { force: true });
    let dir = dirname(filePath);
    while (dir !== prefixPath && dir.startsWith(prefixPath)) {
      try {
        await rmdir(dir);
        dir = dirname(dir);
      } catch {
        break;
      }
    }
  }
  return toDelete;
}

/** Finished archives under the backup prefix, keyed relative to the destination root. */
async function collectArchiveCandidates(root: string, directory: string): Promise<RetentionCandidate[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }

  const candidates: RetentionCandidate[] = [];
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      candidates.push(...(await collectArchiveCandidates(root, fullPath)));
    } else if (entry.isFile() && isArchiveFileName(entry.name)) {
      const { mtime } = await stat(fullPath);
      candidates.push({ key: objectKeyFor(root, fullPath), modifiedAt: mtime });
    }
  }
  return candidates;
}

/** A file's object key within the destination, always using `/` separators. */
function objectKeyFor(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function isMissing(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

/** Resolve an object key inside the destination root, refusing paths that escape it. */
function resolveObjectPath(root: string, objectKey: string): string {
  const path = resolve(root, ...objectKey.split("/"));
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (path !== root && !path.startsWith(rootPrefix)) {
    throw new Error(`Refusing to use object key "${objectKey}" outside the local backup directory.`);
  }
  return path;
}
