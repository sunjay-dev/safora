import { createReadStream, createWriteStream } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Decrypter } from "age-encryption";

/**
 * Downloads an encrypted archive from S3/MinIO and decrypts it with age to a plain dump file.
 */
export async function downloadAndDecryptArchive(options: {
  s3Client: S3Client;
  bucket: string;
  key: string;
  targetDir: string;
  encryptedFileName: string;
  decryptedFileName: string;
  ageIdentity: string;
}): Promise<string> {
  const { s3Client, bucket, key, targetDir, encryptedFileName, decryptedFileName, ageIdentity } = options;

  const encryptedPath = join(targetDir, encryptedFileName);
  const decryptedPath = join(targetDir, decryptedFileName);

  const getRes = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const encryptedStream = getRes.Body as Readable;
  await pipeline(encryptedStream, createWriteStream(encryptedPath));

  const decrypter = new Decrypter();
  decrypter.addIdentity(ageIdentity);
  const inputStream = Readable.toWeb(createReadStream(encryptedPath)) as ReadableStream<Uint8Array>;
  const decryptedStream = await decrypter.decrypt(inputStream);
  await pipeline(decryptedStream, createWriteStream(decryptedPath));

  return decryptedPath;
}
