import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { Decrypter, generateIdentity, identityToRecipient } from "age-encryption";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../config/env.config.js";
import { encryptArchive } from "./encrypt.js";

const execFileAsync = promisify(execFile);

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "encrypt-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("encryptArchive", () => {
  it("encrypts a file in-process and round-trips via Decrypter", async () => {
    const workspace = await temporaryDirectory();
    const plainText = "Sensitive cluster archive content for testing age encryption stream pipeline.";
    const plainPath = join(workspace, "dump.archive.gz");
    await writeFile(plainPath, plainText, "utf8");

    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);

    const config = {
      AGE_RECIPIENT: recipient,
    } as Config;

    const result = await encryptArchive(config, plainPath);

    expect(result.encryptedPath).toBe(`${plainPath}.age`);
    expect(result.bytes).toBeGreaterThan(0);

    // Decrypt in-process using Decrypter over streams
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);

    const decryptedPath = join(workspace, "decrypted.archive.gz");
    const encryptedWebStream = Readable.toWeb(createReadStream(result.encryptedPath)) as ReadableStream<Uint8Array>;
    const decryptedStream = await decrypter.decrypt(encryptedWebStream);
    await pipeline(decryptedStream, createWriteStream(decryptedPath));

    const decryptedContent = await readFile(decryptedPath, "utf8");
    expect(decryptedContent).toBe(plainText);
  });

  it("produces an encrypted artifact that decrypts with the plain age CLI", async () => {
    const workspace = await temporaryDirectory();
    const plainText = "Verify CLI compatibility with age binary.";
    const plainPath = join(workspace, "dump.archive.gz");
    await writeFile(plainPath, plainText, "utf8");

    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);

    const keyPath = join(workspace, "key.txt");
    await writeFile(keyPath, `${identity}\n`, "utf8");

    const config = {
      AGE_RECIPIENT: recipient,
    } as Config;

    const result = await encryptArchive(config, plainPath);

    // Check if age CLI is available
    const hasAgeCli = await execFileAsync("age", ["--version"])
      .then(() => true)
      .catch(() => false);

    if (hasAgeCli) {
      const cliDecryptedPath = join(workspace, "cli-decrypted.archive.gz");
      await execFileAsync("age", ["-d", "-i", keyPath, "-o", cliDecryptedPath, result.encryptedPath]);
      const cliDecryptedContent = await readFile(cliDecryptedPath, "utf8");
      expect(cliDecryptedContent).toBe(plainText);
    }
  });

  it("fails when the input archive file does not exist", async () => {
    const workspace = await temporaryDirectory();
    const nonExistentPath = join(workspace, "missing.archive.gz");

    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);

    const config = {
      AGE_RECIPIENT: recipient,
    } as Config;

    await expect(encryptArchive(config, nonExistentPath)).rejects.toThrow(/age encryption failed:/);
  });

  it("fails when the recipient public key is invalid", async () => {
    const workspace = await temporaryDirectory();
    const plainPath = join(workspace, "dump.archive.gz");
    await writeFile(plainPath, "content", "utf8");

    const config = {
      AGE_RECIPIENT: "age1invalidrecipientkey12345",
    } as Config;

    await expect(encryptArchive(config, plainPath)).rejects.toThrow(/age encryption failed:/);
  });
});
