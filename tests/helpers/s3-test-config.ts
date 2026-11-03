import { loadConfig } from "../../src/config/env.config.js";
import { buildS3Client } from "../../src/storage/client.js";

export interface TestS3Params {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: string;
}

export function getTestS3Params(): TestS3Params {
  return {
    endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000",
    bucket: process.env.S3_BUCKET ?? "test-bucket",
    region: process.env.S3_REGION ?? "us-east-1",
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "minioadmin",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "minioadmin",
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE ?? "true",
  };
}

export function getTestS3Client() {
  const params = getTestS3Params();
  const testConfig = loadConfig({
    DESTINATIONS: "s3",
    ENGINE: "postgres",
    POSTGRESQL_URI: "postgresql://postgres:postgres@localhost:5433/postgres",
    AGE_RECIPIENT: "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p",
    S3_ENDPOINT: params.endpoint,
    S3_BUCKET: params.bucket,
    S3_REGION: params.region,
    S3_ACCESS_KEY_ID: params.accessKeyId,
    S3_SECRET_ACCESS_KEY: params.secretAccessKey,
    S3_FORCE_PATH_STYLE: params.forcePathStyle,
  });
  return { s3Client: buildS3Client(testConfig), params, testConfig };
}
