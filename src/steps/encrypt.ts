import { stat } from "node:fs/promises";
import type { Config } from "../config.js";
import { ENCRYPT_TIMEOUT_MS, MAX_BUFFER } from "../constants.js";
import { execDetail, execFileAsync } from "../lib/exec.js";
import { fail } from "../logging.js";

/** Encrypt the archive with age for the configured (public) recipient key. */
export async function encryptArchive(
  config: Config,
  archivePath: string,
): Promise<{ encryptedPath: string; bytes: number }> {
  const encryptedPath = `${archivePath}.age`;
  try {
    // The recipient is a PUBLIC key, so passing it as an argument leaks nothing.
    await execFileAsync("age", ["-r", config.AGE_RECIPIENT, "-o", encryptedPath, archivePath], {
      timeout: ENCRYPT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
  } catch (err) {
    fail(`age encryption failed:\n${execDetail(err)}`);
  }

  const bytes = (await stat(encryptedPath)).size;
  if (bytes === 0) {
    fail("age reported success but produced an empty file.");
  }
  return { encryptedPath, bytes };
}
