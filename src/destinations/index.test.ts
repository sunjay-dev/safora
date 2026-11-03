import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/env.config.js";
import { buildDestinations } from "./index.js";

const validBaseEnv = {
  MONGODB_URI: "mongodb://localhost:27017/test",
  AGE_RECIPIENT: "age1a4cjc4c8wrw9gr6398fwfr758pcyz7h07qytcx7n98avwxcllfss9tphnr",
};

const validS3Env = {
  ...validBaseEnv,
  S3_ENDPOINT: "https://example.r2.cloudflarestorage.com",
  S3_ACCESS_KEY_ID: "mock-access-key-id",
  S3_SECRET_ACCESS_KEY: "mock-secret-access-key",
  S3_BUCKET: "mock-bucket",
};

const validLocalEnv = {
  ...validBaseEnv,
  LOCAL_BACKUP_DIR: "/var/backups/mongodb",
};

describe("buildDestinations", () => {
  it("builds the selected destinations in the listed order", () => {
    const config = loadConfig({ ...validS3Env, ...validLocalEnv, DESTINATIONS: "s3,local" });

    expect(buildDestinations(config).map((destination) => destination.id)).toEqual(["s3", "local"]);
  });

  it("builds a local-only run without S3 credentials", () => {
    const config = loadConfig({ ...validLocalEnv, DESTINATIONS: "local" });

    expect(buildDestinations(config).map((destination) => destination.id)).toEqual(["local"]);
  });
});
