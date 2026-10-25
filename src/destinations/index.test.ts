import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/env.config.js";
import { buildDestinations } from "./index.js";

const validBaseEnv = {
  MONGODB_URI: "mongodb://localhost:27017/test",
  AGE_RECIPIENT: "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p",
};

const validR2Env = {
  ...validBaseEnv,
  R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
  R2_ACCESS_KEY_ID: "mock-access-key-id",
  R2_SECRET_ACCESS_KEY: "mock-secret-access-key",
  R2_BUCKET: "mock-bucket",
};

const validLocalEnv = {
  ...validBaseEnv,
  LOCAL_BACKUP_DIR: "/var/backups/mongodb",
};

describe("buildDestinations", () => {
  it("builds the selected destinations in the listed order", () => {
    const config = loadConfig({ ...validR2Env, ...validLocalEnv, DESTINATIONS: "r2,local" });

    expect(buildDestinations(config).map((destination) => destination.id)).toEqual(["r2", "local"]);
  });

  it("builds a local-only run without R2 credentials", () => {
    const config = loadConfig({ ...validLocalEnv, DESTINATIONS: "local" });

    expect(buildDestinations(config).map((destination) => destination.id)).toEqual(["local"]);
  });
});
