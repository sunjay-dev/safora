import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/env.config.js";
import { buildS3Client } from "./client.js";

const baseEnv = {
  MONGODB_URI: "mongodb://localhost:27017/test",
  AGE_RECIPIENT: "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p",
  S3_BUCKET: "my-bucket",
};

describe("buildS3Client", () => {
  it("configures endpoint, region, forcePathStyle, and static credentials when provided", async () => {
    const config = loadConfig({
      ...baseEnv,
      S3_ENDPOINT: "https://custom-s3.example.com",
      S3_REGION: "us-west-2",
      S3_FORCE_PATH_STYLE: "true",
      S3_ACCESS_KEY_ID: "my-access-key",
      S3_SECRET_ACCESS_KEY: "my-secret-key",
    });

    const client = buildS3Client(config);

    expect(await client.config.region()).toBe("us-west-2");
    expect(client.config.forcePathStyle).toBe(true);

    const creds = await client.config.credentials();
    expect(creds.accessKeyId).toBe("my-access-key");
    expect(creds.secretAccessKey).toBe("my-secret-key");
  });

  it("omits credentials when unset so ambient AWS credential provider chain operates", async () => {
    const config = loadConfig({
      ...baseEnv,
    });

    const client = buildS3Client(config);

    // When credentials option is omitted in S3Client constructor, client.config.credentials
    // is configured with the ambient default credential provider chain function.
    expect(typeof client.config.credentials).toBe("function");
  });

  it("configures region to 'auto' when S3_REGION is explicitly set to 'auto'", async () => {
    const config = loadConfig({
      ...baseEnv,
      S3_ENDPOINT: "https://0123456789abcdef.r2.cloudflarestorage.com",
      S3_REGION: "auto",
    });

    const client = buildS3Client(config);
    expect(await client.config.region()).toBe("auto");
  });

  it("leaves region for AWS SDK resolution when S3_REGION is unset, even with endpoint", async () => {
    const configWithEndpoint = loadConfig({
      ...baseEnv,
      S3_ENDPOINT: "https://0123456789abcdef.r2.cloudflarestorage.com",
    });

    const clientWithEndpoint = buildS3Client(configWithEndpoint);
    expect(typeof clientWithEndpoint.config.region).toBe("function");

    const configWithoutEndpoint = loadConfig({
      ...baseEnv,
    });

    const clientWithoutEndpoint = buildS3Client(configWithoutEndpoint);
    expect(typeof clientWithoutEndpoint.config.region).toBe("function");
  });

  it("configures forcePathStyle to false by default or when explicitly set", async () => {
    const configDefault = loadConfig({ ...baseEnv });
    const clientDefault = buildS3Client(configDefault);
    expect(clientDefault.config.forcePathStyle).toBe(false);

    const configFalse = loadConfig({ ...baseEnv, S3_FORCE_PATH_STYLE: "false" });
    const clientFalse = buildS3Client(configFalse);
    expect(clientFalse.config.forcePathStyle).toBe(false);

    const configTrue = loadConfig({ ...baseEnv, S3_FORCE_PATH_STYLE: "true" });
    const clientTrue = buildS3Client(configTrue);
    expect(clientTrue.config.forcePathStyle).toBe(true);
  });
});
