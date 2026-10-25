import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Encrypter } from "age-encryption";
import type { Config } from "../config/env.config.js";
import { fail } from "../logging.js";

/** Encrypt the archive with age for the configured (public) recipient key. */
export async function encryptArchive(config: Pick<Config, "AGE_RECIPIENT">, archivePath: string): Promise<{ encryptedPath: string; bytes: number }> {
  const encryptedPath = `${archivePath}.age`;
  try {
    const encrypter = new Encrypter();
    encrypter.addRecipient(config.AGE_RECIPIENT);
    const inputStream = Readable.toWeb(createReadStream(archivePath)) as ReadableStream<Uint8Array>;
    const encryptedStream = await encrypter.encrypt(inputStream);
    await pipeline(encryptedStream, createWriteStream(encryptedPath));
  } catch (err) {
    fail(`age encryption failed:\n${err instanceof Error ? err.message : String(err)}`);
  }

  const bytes = (await stat(encryptedPath)).size;
  if (bytes === 0) {
    fail("age reported success but produced an empty file.");
  }
  return { encryptedPath, bytes };
}
