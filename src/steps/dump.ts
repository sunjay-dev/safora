import { chmod, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.js";
import { DUMP_TIMEOUT_MS, MAX_BUFFER } from "../constants.js";
import { execDetail, execFileAsync } from "../lib/exec.js";
import { fail } from "../logging.js";

/** Full-cluster dump to a single gzipped archive; URI supplied via a private config file. */
export async function runDump(
  config: Config,
  workDir: string,
): Promise<{ archivePath: string; bytes: number }> {
  // JSON is a subset of YAML, so this stays a well-formed mongodump config file
  // no matter which characters the connection string contains.
  const dumpConfigPath = join(workDir, "mongodump.conf");
  await writeFile(dumpConfigPath, `${JSON.stringify({ uri: config.MONGODB_URI })}\n`, { mode: 0o600 });
  await chmod(dumpConfigPath, 0o600); // the mode above can be masked by umask; enforce explicitly

  const archivePath = join(workDir, "dump.archive.gz");
  try {
    await execFileAsync(
      "mongodump",
      // --oplog gives a point-in-time snapshot; requires a replica set (Atlas always is).
      ["--config", dumpConfigPath, `--archive=${archivePath}`, "--gzip", "--oplog"],
      { timeout: DUMP_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
    );
  } catch (err) {
    fail(`mongodump failed:\n${execDetail(err)}`);
  } finally {
    // Remove the file that holds the URI as soon as the dump ends, success or not.
    await rm(dumpConfigPath, { force: true });
  }

  const bytes = (await stat(archivePath)).size;
  if (bytes === 0) {
    fail("mongodump reported success but produced an empty archive.");
  }
  return { archivePath, bytes };
}
