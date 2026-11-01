import { describe, expect, it } from "vitest";
import {
  loadConfig,
  type MongodbConfig,
  parseDbBlocklist,
  parseDestinations,
  parseEngine,
  type PostgresConfig,
  VALID_DESTINATIONS,
  VALID_ENGINES,
} from "./env.config.js";

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

describe("VALID_ENGINES", () => {
  it("exposes the supported engines: mongodb and postgres", () => {
    expect(VALID_ENGINES).toEqual(["mongodb", "postgres"]);
  });
});

describe("parseEngine", () => {
  it("defaults to mongodb when unset, empty, or blank whitespace", () => {
    expect(parseEngine(undefined)).toBe("mongodb");
    expect(parseEngine("")).toBe("mongodb");
    expect(parseEngine("   ")).toBe("mongodb");
    expect(parseEngine("\t \n ")).toBe("mongodb");
  });

  it("trims and lowercases the engine name", () => {
    expect(parseEngine(" MONGODB ")).toBe("mongodb");
    expect(parseEngine(" Postgres ")).toBe("postgres");
  });

  it("rejects an unknown value with a hard error listing the valid values", () => {
    expect(() => parseEngine("mysql")).toThrowError(/Unknown engine "mysql"\. Valid engines are: mongodb, postgres/);
    expect(() => parseEngine("mongodb,postgres")).toThrowError(/Unknown engine "mongodb,postgres"\. Valid engines are: mongodb, postgres/);
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

describe("parseDbBlocklist", () => {
  it("returns [] when unset, empty, or blank", () => {
    expect(parseDbBlocklist(undefined)).toEqual([]);
    expect(parseDbBlocklist("")).toEqual([]);
    expect(parseDbBlocklist("   ")).toEqual([]);
    expect(parseDbBlocklist(",")).toEqual([]);
    expect(parseDbBlocklist(" , , ")).toEqual([]);
  });

  it("returns a single exact name as a pattern", () => {
    expect(parseDbBlocklist("postgres")).toEqual(["postgres"]);
  });

  it("returns glob patterns verbatim (minimatch handles matching)", () => {
    expect(parseDbBlocklist("prisma_migrate_shadow_db_*")).toEqual(["prisma_migrate_shadow_db_*"]);
    expect(parseDbBlocklist("*_test")).toEqual(["*_test"]);
  });

  it("splits on commas and trims each entry", () => {
    expect(parseDbBlocklist("prisma_migrate_shadow_db_*, *_test, template*")).toEqual(["prisma_migrate_shadow_db_*", "*_test", "template*"]);
  });

  it("ignores empty segments including trailing commas", () => {
    expect(parseDbBlocklist("postgres,")).toEqual(["postgres"]);
    expect(parseDbBlocklist(",postgres,")).toEqual(["postgres"]);
    expect(parseDbBlocklist("postgres,,template*")).toEqual(["postgres", "template*"]);
  });
});

const validPostgresEnv = {
  ...validR2Env,
  ENGINE: "postgres",
  POSTGRESQL_URI: "postgresql://backup-user:backup-password@db.internal:5432/app?sslmode=require",
};

describe("loadConfig engine validation matrix", () => {
  it("defaults unset or blank ENGINE to mongodb", () => {
    expect(loadConfig(validR2Env).ENGINE).toBe("mongodb");
    expect(loadConfig({ ...validR2Env, ENGINE: "" }).ENGINE).toBe("mongodb");
    expect(loadConfig({ ...validR2Env, ENGINE: "   " }).ENGINE).toBe("mongodb");
  });

  it("trims and lowercases ENGINE", () => {
    expect(loadConfig({ ...validR2Env, ENGINE: " MONGODB " }).ENGINE).toBe("mongodb");
    expect(loadConfig({ ...validPostgresEnv, ENGINE: " Postgres " }).ENGINE).toBe("postgres");
  });

  it("rejects an unknown ENGINE with an error listing the valid engines", () => {
    expect(() => loadConfig({ ...validR2Env, ENGINE: "mysql" })).toThrowError(
      /ENGINE: Unknown engine "mysql"\. Valid engines are: mongodb, postgres/,
    );
    expect(() => loadConfig({ ...validR2Env, ENGINE: "mongodb,postgres" })).toThrowError(
      /ENGINE: Unknown engine "mongodb,postgres"\. Valid engines are: mongodb, postgres/,
    );
  });

  it("requires MONGODB_URI if and only if mongodb is selected", () => {
    const missingUri = { ...validR2Env };
    delete (missingUri as Record<string, string | undefined>).MONGODB_URI;
    expect(() => loadConfig(missingUri)).toThrowError(/MONGODB_URI: missing environment variable/);

    expect(() => loadConfig({ ...validR2Env, MONGODB_URI: "" })).toThrowError(/MONGODB_URI must not be empty/);

    // Postgres selected: MONGODB_URI is not required and is ignored entirely.
    expect(() => loadConfig({ ...validPostgresEnv, MONGODB_URI: undefined })).not.toThrow();
    expect(loadConfig({ ...validPostgresEnv, MONGODB_URI: "not a mongodb uri" })).not.toHaveProperty("MONGODB_URI");
  });

  it("requires POSTGRESQL_URI if and only if postgres is selected", () => {
    const missingUri = { ...validR2Env, ENGINE: "postgres" };
    expect(() => loadConfig(missingUri)).toThrowError(/POSTGRESQL_URI: missing environment variable/);

    expect(() => loadConfig({ ...missingUri, POSTGRESQL_URI: "" })).toThrowError(/POSTGRESQL_URI must not be empty/);

    // MongoDB selected: POSTGRESQL_URI is not required and is ignored entirely.
    expect(() => loadConfig(validR2Env)).not.toThrow();
    expect(loadConfig({ ...validR2Env, POSTGRESQL_URI: "not a postgres uri" })).not.toHaveProperty("POSTGRESQL_URI");
  });

  it("accepts postgres:// and postgresql:// URIs and never rewrites them", () => {
    const postgresUri = "postgres://backup-user:p%40ss%2Fword@db.internal/app";
    const postgresqlUri = "postgresql://backup-user:backup-password@db.internal:5433/app?sslmode=verify-full";

    expect(loadConfig({ ...validPostgresEnv, POSTGRESQL_URI: postgresUri })).toMatchObject({
      ENGINE: "postgres",
      POSTGRESQL_URI: postgresUri,
    });
    expect(loadConfig({ ...validPostgresEnv, POSTGRESQL_URI: postgresqlUri })).toMatchObject({
      ENGINE: "postgres",
      POSTGRESQL_URI: postgresqlUri,
    });
  });

  it("rejects an invalid POSTGRESQL_URI with a clear error that never echoes the URI", () => {
    const invalidUri = "postgresql://backup-user:sup3r-s3cret@[broken-host/app";

    let message = "";
    expect(() => {
      try {
        loadConfig({ ...validPostgresEnv, POSTGRESQL_URI: invalidUri });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
        throw err;
      }
    }).toThrowError(/POSTGRESQL_URI must be a valid PostgreSQL connection URI/);

    expect(message).not.toContain(invalidUri);
    expect(message).not.toContain("sup3r-s3cret");
  });

  it("rejects a POSTGRESQL_URI with a non-postgres scheme", () => {
    expect(() => loadConfig({ ...validPostgresEnv, POSTGRESQL_URI: "mysql://backup-user:secret@db.internal/app" })).toThrowError(
      /POSTGRESQL_URI must be a valid PostgreSQL connection URI/,
    );
  });

  it("returns only the selected engine's connection variable", () => {
    const mongodbConfig = loadConfig(validR2Env);
    expect(mongodbConfig).toMatchObject({
      ENGINE: "mongodb",
      MONGODB_URI: "mongodb://localhost:27017/test",
      MONGODB_DB_BLOCKLIST: [],
    });
    expect(mongodbConfig).not.toHaveProperty("POSTGRESQL_URI");

    const postgresConfig = loadConfig(validPostgresEnv);
    expect(postgresConfig).toMatchObject({
      ENGINE: "postgres",
      POSTGRESQL_URI: "postgresql://backup-user:backup-password@db.internal:5432/app?sslmode=require",
      PG_DB_BLOCKLIST: [],
    });
    expect(postgresConfig).not.toHaveProperty("MONGODB_URI");

    const mongodbWithBlocklist = loadConfig({
      ...validR2Env,
      MONGODB_DB_BLOCKLIST: "scratch_*, *_dev",
    });
    expect((mongodbWithBlocklist as MongodbConfig).MONGODB_DB_BLOCKLIST).toEqual(["scratch_*", "*_dev"]);

    // DB_BLOCKLIST fallback for both engines
    const mongoWithCommonBlocklist = loadConfig({
      ...validR2Env,
      DB_BLOCKLIST: "common_junk_*",
    });
    expect((mongoWithCommonBlocklist as MongodbConfig).MONGODB_DB_BLOCKLIST).toEqual(["common_junk_*"]);

    const pgWithCommonBlocklist = loadConfig({
      ...validPostgresEnv,
      DB_BLOCKLIST: "common_junk_*",
    });
    expect((pgWithCommonBlocklist as PostgresConfig).PG_DB_BLOCKLIST).toEqual(["common_junk_*"]);

    // Empty string or whitespace in engine-specific variable must fall back to DB_BLOCKLIST (e.g. GitHub Actions unset vars)
    const pgWithEmptySpecific = loadConfig({
      ...validPostgresEnv,
      PG_DB_BLOCKLIST: "",
      DB_BLOCKLIST: "prisma_migrate_shadow_db_*, *test*",
    });
    expect((pgWithEmptySpecific as PostgresConfig).PG_DB_BLOCKLIST).toEqual(["prisma_migrate_shadow_db_*", "*test*"]);

    const mongoWithWhitespaceSpecific = loadConfig({
      ...validR2Env,
      MONGODB_DB_BLOCKLIST: "   ",
      DB_BLOCKLIST: "common_junk_*",
    });
    expect((mongoWithWhitespaceSpecific as MongodbConfig).MONGODB_DB_BLOCKLIST).toEqual(["common_junk_*"]);

    // Engine-specific variable takes precedence over DB_BLOCKLIST when non-empty
    const pgWithBoth = loadConfig({
      ...validPostgresEnv,
      PG_DB_BLOCKLIST: "pg_specific_*",
      DB_BLOCKLIST: "common_*",
    });
    expect((pgWithBoth as PostgresConfig).PG_DB_BLOCKLIST).toEqual(["pg_specific_*"]);
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
