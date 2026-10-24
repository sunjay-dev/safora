import { chmod, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config/env.config.js";
import { execDetail, execFileAsync } from "../lib/exec.js";
import { fail } from "../logging.js";

/** Full-cluster dump to a single gzipped archive; URI supplied via a private config file. */
export async function runDump(
  config: Config,
  workDir: string,
): Promise<{ archivePath: string; bytes: number }> {
  const dumpConfigPath = join(workDir, "mongodump.conf");
  await writeFile(dumpConfigPath, `${JSON.stringify({ uri: config.MONGODB_URI })}\n`, {
    mode: 0o600,
  });
  await chmod(dumpConfigPath, 0o600);

  const archivePath = join(workDir, "dump.archive.gz");
  try {
    await execFileAsync(
      "mongodump",
      ["--config", dumpConfigPath, `--archive=${archivePath}`, "--gzip", "--oplog"],
      { timeout: config.DUMP_TIMEOUT_MS, maxBuffer: config.MAX_BUFFER },
    );
  } catch (err) {
    fail(`mongodump failed:\n${execDetail(err)}`);
  } finally {
    await rm(dumpConfigPath, { force: true });
  }

  const bytes = (await stat(archivePath)).size;
  if (bytes === 0) {
    fail("mongodump reported success but produced an empty archive.");
  }
  return { archivePath, bytes };
}
