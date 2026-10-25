import { describe, expect, it } from "vitest";
import { loadConfig, parseDestinations, VALID_DESTINATIONS } from "./env.config.js";

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
  DESTINATIONS: "local",
  LOCAL_BACKUP_DIR: "/var/backups/mongodb",
};

describe("VALID_DESTINATIONS", () => {
  it("exposes the supported destinations: r2 and local", () => {
    expect(VALID_DESTINATIONS).toEqual(["r2", "local"]);
  });
});

describe("parseDestinations", () => {
  it("defaults to ['r2'] when unset, empty, or blank whitespace", () => {
    expect(parseDestinations(undefined)).toEqual(["r2"]);
    expect(parseDestinations("")).toEqual(["r2"]);
    expect(parseDestinations("   ")).toEqual(["r2"]);
    expect(parseDestinations("\t \n ")).toEqual(["r2"]);
    expect(parseDestinations(",")).toEqual(["r2"]);
    expect(parseDestinations(" , , ")).toEqual(["r2"]);
  });

  it("trims and lowercases entries", () => {
    expect(parseDestinations(" R2 ")).toEqual(["r2"]);
    expect(parseDestinations(" LOCAL ")).toEqual(["local"]);
    expect(parseDestinations(" R2 , LOCAL ")).toEqual(["r2", "local"]);
    expect(parseDestinations("local, r2")).toEqual(["local", "r2"]);
  });

  it("ignores empty segments including trailing commas", () => {
    expect(parseDestinations("r2,")).toEqual(["r2"]);
    expect(parseDestinations(",r2,")).toEqual(["r2"]);
    expect(parseDestinations("r2,,local")).toEqual(["r2", "local"]);
    expect(parseDestinations("local, r2, ")).toEqual(["local", "r2"]);
  });

  it("rejects an unknown value with a hard error listing the valid values", () => {
    expect(() => parseDestinations("s3")).toThrowError(/Unknown destination "s3"\. Valid destinations are: r2, local/);
    expect(() => parseDestinations("r2, ftp")).toThrowError(/Unknown destination "ftp"\. Valid destinations are: r2, local/);
  });

  it("rejects duplicate entries", () => {
    expect(() => parseDestinations("r2, r2")).toThrowError(/Duplicate destination "r2"/);
    expect(() => parseDestinations("local, LOCAL")).toThrowError(/Duplicate destination "local"/);
    expect(() => parseDestinations("r2, local, r2")).toThrowError(/Duplicate destination "r2"/);
  });
});

describe("loadConfig destination validation matrix", () => {
  it("defaults unset or blank DESTINATIONS to r2", () => {
    const configUnset = loadConfig(validR2Env);
    expect(configUnset.DESTINATIONS).toEqual(["r2"]);

    const configEmpty = loadConfig({ ...validR2Env, DESTINATIONS: "" });
    expect(configEmpty.DESTINATIONS).toEqual(["r2"]);

    const configBlank = loadConfig({ ...validR2Env, DESTINATIONS: "   " });
    expect(configBlank.DESTINATIONS).toEqual(["r2"]);
  });

  it("trims, lowercases, and ignores empty segments in DESTINATIONS", () => {
    const config = loadConfig({ ...validR2Env, DESTINATIONS: " r2, " });
    expect(config.DESTINATIONS).toEqual(["r2"]);

    const configBoth = loadConfig({
      ...validR2Env,
      ...validLocalEnv,
      DESTINATIONS: " R2, , LOCAL, ",
    });
    expect(configBoth.DESTINATIONS).toEqual(["r2", "local"]);
  });

  it("rejects an unknown destination in loadConfig with error listing valid values", () => {
    expect(() => loadConfig({ ...validR2Env, DESTINATIONS: "s3" })).toThrowError(/Unknown destination "s3"\. Valid destinations are: r2, local/);
  });

  it("rejects a duplicate destination entry in loadConfig", () => {
    expect(() => loadConfig({ ...validR2Env, DESTINATIONS: "r2, r2" })).toThrowError(/Duplicate destination "r2"/);
  });

  it("validates when local is selected and R2 variables are missing", () => {
    const config = loadConfig(validLocalEnv);
    expect(config.DESTINATIONS).toEqual(["local"]);
    expect(config.LOCAL_BACKUP_DIR).toBe("/var/backups/mongodb");
    expect(config.R2_ENDPOINT).toBeUndefined();
    expect(config.R2_ACCESS_KEY_ID).toBeUndefined();
    expect(config.R2_SECRET_ACCESS_KEY).toBeUndefined();
    expect(config.R2_BUCKET).toBeUndefined();
  });

  it("fails validation when r2 is selected and R2 variables are missing", () => {
    const envWithoutBucket = { ...validR2Env };
    delete (envWithoutBucket as Record<string, string | undefined>).R2_BUCKET;

    expect(() => loadConfig(envWithoutBucket)).toThrowError(/R2_BUCKET: missing environment variable/);
  });

  it("ignores unselected destinations' variables entirely", () => {
    // When local is selected, invalid R2 variables are ignored
    const localWithBadR2 = {
      ...validLocalEnv,
      R2_ENDPOINT: "not-a-valid-https-url",
      R2_BUCKET: "",
      R2_ACCESS_KEY_ID: "",
    };
    const configLocal = loadConfig(localWithBadR2);
    expect(configLocal.DESTINATIONS).toEqual(["local"]);
    expect(configLocal.R2_ENDPOINT).toBeUndefined();

    // When r2 is selected, invalid LOCAL_BACKUP_DIR is ignored
    const r2WithBadLocal = {
      ...validR2Env,
      LOCAL_BACKUP_DIR: "",
    };
    const configR2 = loadConfig(r2WithBadLocal);
    expect(configR2.DESTINATIONS).toEqual(["r2"]);
    expect(configR2.LOCAL_BACKUP_DIR).toBeUndefined();
  });

  it("requires LOCAL_BACKUP_DIR if and only if local is selected", () => {
    // Missing when local selected -> error
    const localMissingDir = { ...validLocalEnv };
    delete (localMissingDir as Record<string, string | undefined>).LOCAL_BACKUP_DIR;
    expect(() => loadConfig(localMissingDir)).toThrowError(/LOCAL_BACKUP_DIR: missing environment variable/);

    // Empty when local selected -> error
    const localEmptyDir = { ...validLocalEnv, LOCAL_BACKUP_DIR: "" };
    expect(() => loadConfig(localEmptyDir)).toThrowError(/LOCAL_BACKUP_DIR must not be empty/);

    // Missing when r2 selected -> valid
    expect(() => loadConfig(validR2Env)).not.toThrow();

    // Both selected -> LOCAL_BACKUP_DIR is required
    const bothMissingDir = {
      ...validR2Env,
      DESTINATIONS: "r2,local",
    };
    expect(() => loadConfig(bothMissingDir)).toThrowError(/LOCAL_BACKUP_DIR: missing environment variable/);
  });

  it("validates multi-destination config when all selected destinations are valid", () => {
    const config = loadConfig({
      ...validR2Env,
      ...validLocalEnv,
      DESTINATIONS: "local, r2",
    });

    expect(config.DESTINATIONS).toEqual(["local", "r2"]);
    expect(config.LOCAL_BACKUP_DIR).toBe("/var/backups/mongodb");
    expect(config.R2_BUCKET).toBe("mock-bucket");
    expect(config.R2_ENDPOINT).toBe("https://example.r2.cloudflarestorage.com");
  });

  it("surfaces configuration errors at config load", () => {
    expect(() =>
      loadConfig({
        DESTINATIONS: "r2",
      }),
    ).toThrowError(/Invalid configuration:/);
  });
});
