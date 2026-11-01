import { describe, expect, it } from "vitest";
import {
  ACCEPTED_DESTINATIONS,
  loadConfig,
  type MongodbConfig,
  parseDbBlocklist,
  parseDestinations,
  parseEngine,
  type PostgresConfig,
  S3EnvSchema,
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

const validS3Env = {
  ...validBaseEnv,
  S3_ENDPOINT: "https://s3.amazonaws.com",
  S3_ACCESS_KEY_ID: "mock-s3-access-key-id",
  S3_SECRET_ACCESS_KEY: "mock-s3-secret-access-key",
  S3_BUCKET: "mock-s3-bucket",
  S3_REGION: "us-east-1",
};

const validLocalEnv = {
  ...validBaseEnv,
  DESTINATIONS: "local",
  LOCAL_BACKUP_DIR: "/var/backups/mongodb",
};

describe("VALID_DESTINATIONS", () => {
  it("exposes the canonical destinations: s3 and local", () => {
    expect(VALID_DESTINATIONS).toEqual(["s3", "local"]);
  });
});

describe("ACCEPTED_DESTINATIONS", () => {
  it("exposes the accepted destination inputs: s3, r2, and local", () => {
    expect(ACCEPTED_DESTINATIONS).toEqual(["s3", "r2", "local"]);
  });
});

describe("S3EnvSchema", () => {
  it("is exported as a Zod schema", () => {
    expect(S3EnvSchema.safeParse).toBeTypeOf("function");
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
  it("defaults to ['s3'] when unset, empty, or blank whitespace", () => {
    expect(parseDestinations(undefined)).toEqual(["s3"]);
    expect(parseDestinations("")).toEqual(["s3"]);
    expect(parseDestinations("   ")).toEqual(["s3"]);
    expect(parseDestinations("\t \n ")).toEqual(["s3"]);
    expect(parseDestinations(",")).toEqual(["s3"]);
    expect(parseDestinations(" , , ")).toEqual(["s3"]);
  });

  it("trims and lowercases entries and normalizes r2 to s3", () => {
    expect(parseDestinations(" S3 ")).toEqual(["s3"]);
    expect(parseDestinations(" R2 ")).toEqual(["s3"]);
    expect(parseDestinations(" LOCAL ")).toEqual(["local"]);
    expect(parseDestinations(" S3 , LOCAL ")).toEqual(["s3", "local"]);
    expect(parseDestinations(" R2 , LOCAL ")).toEqual(["s3", "local"]);
    expect(parseDestinations("local, r2")).toEqual(["local", "s3"]);
    expect(parseDestinations("local, s3")).toEqual(["local", "s3"]);
  });

  it("ignores empty segments including trailing commas", () => {
    expect(parseDestinations("s3,")).toEqual(["s3"]);
    expect(parseDestinations(",s3,")).toEqual(["s3"]);
    expect(parseDestinations("r2,")).toEqual(["s3"]);
    expect(parseDestinations(",r2,")).toEqual(["s3"]);
    expect(parseDestinations("s3,,local")).toEqual(["s3", "local"]);
    expect(parseDestinations("r2,,local")).toEqual(["s3", "local"]);
    expect(parseDestinations("local, s3, ")).toEqual(["local", "s3"]);
    expect(parseDestinations("local, r2, ")).toEqual(["local", "s3"]);
  });

  it("rejects an unknown value with a hard error listing the valid values", () => {
    expect(() => parseDestinations("ftp")).toThrowError(/Unknown destination "ftp"\. Valid destinations are: s3, r2, local/);
    expect(() => parseDestinations("s3, ftp")).toThrowError(/Unknown destination "ftp"\. Valid destinations are: s3, r2, local/);
    expect(() => parseDestinations("r2, ftp")).toThrowError(/Unknown destination "ftp"\. Valid destinations are: s3, r2, local/);
  });

  it("rejects duplicate entries including alias combinations", () => {
    expect(() => parseDestinations("s3, s3")).toThrowError(/Duplicate destination "s3"/);
    expect(() => parseDestinations("r2, r2")).toThrowError(/Duplicate destination "r2"/);
    expect(() => parseDestinations("s3, r2")).toThrowError(/Duplicate destination "r2"/);
    expect(() => parseDestinations("r2, s3")).toThrowError(/Duplicate destination "s3"/);
    expect(() => parseDestinations("local, LOCAL")).toThrowError(/Duplicate destination "local"/);
    expect(() => parseDestinations("s3, local, r2")).toThrowError(/Duplicate destination "r2"/);
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
  it("defaults unset or blank DESTINATIONS to s3", () => {
    const configUnset = loadConfig(validR2Env);
    expect(configUnset.DESTINATIONS).toEqual(["s3"]);

    const configEmpty = loadConfig({ ...validR2Env, DESTINATIONS: "" });
    expect(configEmpty.DESTINATIONS).toEqual(["s3"]);

    const configBlank = loadConfig({ ...validR2Env, DESTINATIONS: "   " });
    expect(configBlank.DESTINATIONS).toEqual(["s3"]);
  });

  it("trims, lowercases, and ignores empty segments in DESTINATIONS, normalizing r2 to s3", () => {
    const config = loadConfig({ ...validR2Env, DESTINATIONS: " r2, " });
    expect(config.DESTINATIONS).toEqual(["s3"]);

    const configS3 = loadConfig({ ...validS3Env, DESTINATIONS: " s3, " });
    expect(configS3.DESTINATIONS).toEqual(["s3"]);

    const configBoth = loadConfig({
      ...validR2Env,
      ...validLocalEnv,
      DESTINATIONS: " R2, , LOCAL, ",
    });
    expect(configBoth.DESTINATIONS).toEqual(["s3", "local"]);

    const configS3Local = loadConfig({
      ...validS3Env,
      ...validLocalEnv,
      DESTINATIONS: " S3, , LOCAL, ",
    });
    expect(configS3Local.DESTINATIONS).toEqual(["s3", "local"]);
  });

  it("rejects an unknown destination in loadConfig with error listing valid values", () => {
    expect(() => loadConfig({ ...validR2Env, DESTINATIONS: "bad" })).toThrowError(
      /DESTINATIONS: Unknown destination "bad"\. Valid destinations are: s3, r2, local/,
    );
  });

  it("rejects duplicate destination entries in loadConfig, including alias combinations", () => {
    expect(() => loadConfig({ ...validR2Env, DESTINATIONS: "r2, r2" })).toThrowError(/Duplicate destination "r2"/);
    expect(() => loadConfig({ ...validS3Env, DESTINATIONS: "s3, s3" })).toThrowError(/Duplicate destination "s3"/);
    expect(() => loadConfig({ ...validS3Env, DESTINATIONS: "s3, r2" })).toThrowError(/Duplicate destination "r2"/);
    expect(() => loadConfig({ ...validS3Env, DESTINATIONS: "r2, s3" })).toThrowError(/Duplicate destination "s3"/);
  });

  it("validates when local is selected and S3/R2 variables are missing", () => {
    const config = loadConfig(validLocalEnv);
    expect(config.DESTINATIONS).toEqual(["local"]);
    expect(config.LOCAL_BACKUP_DIR).toBe("/var/backups/mongodb");
    expect(config.S3_ENDPOINT).toBeUndefined();
    expect(config.S3_ACCESS_KEY_ID).toBeUndefined();
    expect(config.S3_SECRET_ACCESS_KEY).toBeUndefined();
    expect(config.S3_BUCKET).toBeUndefined();
    expect(config.S3_FORCE_PATH_STYLE).toBeUndefined();
  });

  it("fails validation when s3 is selected and bucket is missing", () => {
    const envWithoutBucket = { ...validR2Env };
    delete (envWithoutBucket as Record<string, string | undefined>).R2_BUCKET;

    expect(() => loadConfig(envWithoutBucket)).toThrowError(/S3_BUCKET: missing environment variable/);
  });

  it("ignores unselected destinations' variables entirely", () => {
    // When local is selected, invalid S3 variables are ignored
    const localWithBadS3 = {
      ...validLocalEnv,
      S3_ENDPOINT: "not-a-valid-https-url",
      S3_BUCKET: "",
      S3_ACCESS_KEY_ID: "",
    };
    const configLocal = loadConfig(localWithBadS3);
    expect(configLocal.DESTINATIONS).toEqual(["local"]);
    expect(configLocal.S3_ENDPOINT).toBeUndefined();

    // When s3 is selected, invalid LOCAL_BACKUP_DIR is ignored
    const s3WithBadLocal = {
      ...validS3Env,
      LOCAL_BACKUP_DIR: "",
    };
    const configS3 = loadConfig(s3WithBadLocal);
    expect(configS3.DESTINATIONS).toEqual(["s3"]);
    expect(configS3.LOCAL_BACKUP_DIR).toBeUndefined();
  });

  it("requires LOCAL_BACKUP_DIR if and only if local is selected", () => {
    // Missing when local selected -> error
    const localMissingDir = { ...validLocalEnv };
    delete (localMissingDir as Record<string, string | undefined>).LOCAL_BACKUP_DIR;
    expect(() => loadConfig(localMissingDir)).toThrowError(/LOCAL_BACKUP_DIR: missing environment variable/);

    // Empty when local selected -> error
    const localEmptyDir = { ...validLocalEnv, LOCAL_BACKUP_DIR: "" };
    expect(() => loadConfig(localEmptyDir)).toThrowError(/LOCAL_BACKUP_DIR must not be empty/);

    // Missing when s3 selected -> valid
    expect(() => loadConfig(validS3Env)).not.toThrow();

    // Both selected -> LOCAL_BACKUP_DIR is required
    const bothMissingDir = {
      ...validS3Env,
      DESTINATIONS: "s3,local",
    };
    expect(() => loadConfig(bothMissingDir)).toThrowError(/LOCAL_BACKUP_DIR: missing environment variable/);
  });

  it("validates multi-destination config when all selected destinations are valid", () => {
    const config = loadConfig({
      ...validR2Env,
      ...validLocalEnv,
      DESTINATIONS: "local, r2",
    });

    expect(config.DESTINATIONS).toEqual(["local", "s3"]);
    expect(config.LOCAL_BACKUP_DIR).toBe("/var/backups/mongodb");
    expect(config.S3_BUCKET).toBe("mock-bucket");
    expect(config.S3_ENDPOINT).toBe("https://example.r2.cloudflarestorage.com");
  });

  it("surfaces configuration errors at config load", () => {
    expect(() =>
      loadConfig({
        DESTINATIONS: "s3",
      }),
    ).toThrowError(/Invalid configuration:/);
  });
});

describe("loadConfig S3 configuration matrix & precedence", () => {
  it("parses canonical S3 configuration with static credentials", () => {
    const config = loadConfig(validS3Env);
    expect(config.S3_BUCKET).toBe("mock-s3-bucket");
    expect(config.S3_ENDPOINT).toBe("https://s3.amazonaws.com");
    expect(config.S3_REGION).toBe("us-east-1");
    expect(config.S3_ACCESS_KEY_ID).toBe("mock-s3-access-key-id");
    expect(config.S3_SECRET_ACCESS_KEY).toBe("mock-s3-secret-access-key");
    expect(config.S3_FORCE_PATH_STYLE).toBe(false);

    // Backward compatibility aliases
    expect(config.R2_BUCKET).toBe("mock-s3-bucket");
    expect(config.R2_ENDPOINT).toBe("https://s3.amazonaws.com");
    expect(config.R2_ACCESS_KEY_ID).toBe("mock-s3-access-key-id");
    expect(config.R2_SECRET_ACCESS_KEY).toBe("mock-s3-secret-access-key");
  });

  describe("bucket resolution and precedence", () => {
    it("falls back to legacy R2_BUCKET when S3_BUCKET is unset", () => {
      const config = loadConfig(validR2Env);
      expect(config.S3_BUCKET).toBe("mock-bucket");
      expect(config.R2_BUCKET).toBe("mock-bucket");
    });

    it("gives S3_BUCKET precedence over R2_BUCKET when both are provided", () => {
      const config = loadConfig({
        ...validS3Env,
        R2_BUCKET: "legacy-bucket",
        S3_BUCKET: "canonical-bucket",
      });
      expect(config.S3_BUCKET).toBe("canonical-bucket");
      expect(config.R2_BUCKET).toBe("canonical-bucket");
    });

    it("falls back to R2_BUCKET when S3_BUCKET is blank whitespace", () => {
      const config = loadConfig({
        ...validR2Env,
        S3_BUCKET: "   ",
      });
      expect(config.S3_BUCKET).toBe("mock-bucket");
    });

    it("fails when neither S3_BUCKET nor R2_BUCKET is provided", () => {
      const noBucket = { ...validS3Env };
      delete (noBucket as Record<string, string | undefined>).S3_BUCKET;
      expect(() => loadConfig(noBucket)).toThrowError(/S3_BUCKET: missing environment variable/);
    });

    it("fails when S3_BUCKET is an empty string and R2_BUCKET is unset", () => {
      const emptyBucket = { ...validS3Env, S3_BUCKET: "" };
      expect(() => loadConfig(emptyBucket)).toThrowError(/S3_BUCKET must not be empty/);
    });

    it("fails when S3_BUCKET is unset and R2_BUCKET is an empty string", () => {
      const emptyR2Bucket = { ...validR2Env, R2_BUCKET: "" };
      expect(() => loadConfig(emptyR2Bucket)).toThrowError(/R2_BUCKET must not be empty/);
    });
  });

  describe("endpoint resolution and precedence", () => {
    it("leaves endpoint undefined when neither S3_ENDPOINT nor R2_ENDPOINT is supplied (native AWS)", () => {
      const awsEnv = { ...validS3Env };
      delete (awsEnv as Record<string, string | undefined>).S3_ENDPOINT;
      const config = loadConfig(awsEnv);
      expect(config.S3_ENDPOINT).toBeUndefined();
      expect(config.R2_ENDPOINT).toBeUndefined();
    });

    it("accepts valid https:// endpoint and strips trailing slashes", () => {
      const config = loadConfig({
        ...validS3Env,
        S3_ENDPOINT: "https://custom-s3.example.com///",
      });
      expect(config.S3_ENDPOINT).toBe("https://custom-s3.example.com");
    });

    it("accepts valid http:// endpoint for local/MinIO development", () => {
      const config = loadConfig({
        ...validS3Env,
        S3_ENDPOINT: "http://localhost:9000/",
      });
      expect(config.S3_ENDPOINT).toBe("http://localhost:9000");
    });

    it("falls back to R2_ENDPOINT when S3_ENDPOINT is unset", () => {
      const config = loadConfig(validR2Env);
      expect(config.S3_ENDPOINT).toBe("https://example.r2.cloudflarestorage.com");
    });

    it("gives S3_ENDPOINT precedence over R2_ENDPOINT when both are provided", () => {
      const config = loadConfig({
        ...validS3Env,
        S3_ENDPOINT: "https://s3.primary.example.com",
        R2_ENDPOINT: "https://r2.legacy.example.com",
      });
      expect(config.S3_ENDPOINT).toBe("https://s3.primary.example.com");
      expect(config.R2_ENDPOINT).toBe("https://s3.primary.example.com");
    });

    it("falls back to R2_ENDPOINT when S3_ENDPOINT is blank whitespace", () => {
      const config = loadConfig({
        ...validR2Env,
        S3_ENDPOINT: "   ",
      });
      expect(config.S3_ENDPOINT).toBe("https://example.r2.cloudflarestorage.com");
    });

    it("rejects invalid URL for S3_ENDPOINT", () => {
      expect(() =>
        loadConfig({
          ...validS3Env,
          S3_ENDPOINT: "not-a-valid-url",
        }),
      ).toThrowError(/S3_ENDPOINT must be a valid URL/);
    });

    it("rejects non-http/https protocol for S3_ENDPOINT", () => {
      expect(() =>
        loadConfig({
          ...validS3Env,
          S3_ENDPOINT: "ftp://storage.internal/bucket",
        }),
      ).toThrowError(/S3_ENDPOINT must use http:\/\/ or https:\/\//);
    });

    it("rejects invalid URL for R2_ENDPOINT when used as fallback", () => {
      const invalidR2 = {
        ...validR2Env,
        R2_ENDPOINT: "not-a-valid-url",
      };
      expect(() => loadConfig(invalidR2)).toThrowError(/R2_ENDPOINT must be a valid URL/);
    });

    it("rejects non-http/https protocol for R2_ENDPOINT when used as fallback", () => {
      const invalidR2 = {
        ...validR2Env,
        R2_ENDPOINT: "ftp://example.r2.cloudflarestorage.com",
      };
      expect(() => loadConfig(invalidR2)).toThrowError(/R2_ENDPOINT must use http:\/\/ or https:\/\//);
    });
  });

  describe("region resolution strategy", () => {
    it("uses explicitly provided S3_REGION directly", () => {
      const config = loadConfig({
        ...validS3Env,
        S3_REGION: "us-west-2",
      });
      expect(config.S3_REGION).toBe("us-west-2");
    });

    it("explicit S3_REGION takes precedence even when legacy R2 variables are active", () => {
      const config = loadConfig({
        ...validR2Env,
        S3_REGION: "eu-central-1",
      });
      expect(config.S3_REGION).toBe("eu-central-1");
    });

    it("defaults to 'auto' when S3_REGION is unset and legacy R2 configuration is active", () => {
      const config = loadConfig(validR2Env);
      expect(config.S3_REGION).toBe("auto");
    });

    it("defaults to 'auto' when S3_REGION is unset and endpoint is a Cloudflare R2 endpoint", () => {
      const config = loadConfig({
        ...validBaseEnv,
        S3_BUCKET: "my-bucket",
        S3_ENDPOINT: "https://0123456789abcdef.r2.cloudflarestorage.com",
        S3_ACCESS_KEY_ID: "key",
        S3_SECRET_ACCESS_KEY: "secret",
      });
      expect(config.S3_REGION).toBe("auto");
    });

    it("leaves region undefined when S3_REGION is unset on native AWS S3 (no endpoint, no R2 variables)", () => {
      const awsEnv = {
        ...validBaseEnv,
        S3_BUCKET: "my-native-bucket",
        S3_ACCESS_KEY_ID: "aws-key",
        S3_SECRET_ACCESS_KEY: "aws-secret",
      };
      const config = loadConfig(awsEnv);
      expect(config.S3_REGION).toBeUndefined();
    });

    it("leaves region undefined when S3_REGION is unset on custom non-R2 endpoint (e.g. MinIO)", () => {
      const minioEnv = {
        ...validBaseEnv,
        S3_BUCKET: "minio-bucket",
        S3_ENDPOINT: "http://localhost:9000",
        S3_ACCESS_KEY_ID: "minioadmin",
        S3_SECRET_ACCESS_KEY: "minioadmin",
      };
      const config = loadConfig(minioEnv);
      expect(config.S3_REGION).toBeUndefined();
    });
  });

  describe("credential boundary, fallback, and ambient IAM/OIDC support", () => {
    it("resolves strictly from S3_* prefix when both static credentials are provided", () => {
      const config = loadConfig({
        ...validS3Env,
        R2_ACCESS_KEY_ID: "legacy-key",
        R2_SECRET_ACCESS_KEY: "legacy-secret",
      });
      expect(config.S3_ACCESS_KEY_ID).toBe("mock-s3-access-key-id");
      expect(config.S3_SECRET_ACCESS_KEY).toBe("mock-s3-secret-access-key");
    });

    it("enforces strict credential boundary: fails loudly when S3_ACCESS_KEY_ID is set without S3_SECRET_ACCESS_KEY", () => {
      const partialS3 = {
        ...validS3Env,
        S3_ACCESS_KEY_ID: "s3-only-key",
        R2_SECRET_ACCESS_KEY: "r2-secret-must-not-be-mixed",
      };
      delete (partialS3 as Record<string, string | undefined>).S3_SECRET_ACCESS_KEY;

      expect(() => loadConfig(partialS3)).toThrowError(/S3_SECRET_ACCESS_KEY: missing environment variable/);
    });

    it("enforces strict credential boundary: fails loudly when S3_SECRET_ACCESS_KEY is set without S3_ACCESS_KEY_ID", () => {
      const partialS3 = {
        ...validS3Env,
        S3_SECRET_ACCESS_KEY: "s3-only-secret",
        R2_ACCESS_KEY_ID: "r2-key-must-not-be-mixed",
      };
      delete (partialS3 as Record<string, string | undefined>).S3_ACCESS_KEY_ID;

      expect(() => loadConfig(partialS3)).toThrowError(/S3_ACCESS_KEY_ID: missing environment variable/);
    });

    it("fails when S3_ACCESS_KEY_ID is provided and S3_SECRET_ACCESS_KEY is an empty string", () => {
      expect(() =>
        loadConfig({
          ...validS3Env,
          S3_ACCESS_KEY_ID: "key",
          S3_SECRET_ACCESS_KEY: "",
        }),
      ).toThrowError(/S3_SECRET_ACCESS_KEY must not be empty/);
    });

    it("fails when S3_SECRET_ACCESS_KEY is provided and S3_ACCESS_KEY_ID is an empty string", () => {
      expect(() =>
        loadConfig({
          ...validS3Env,
          S3_ACCESS_KEY_ID: "",
          S3_SECRET_ACCESS_KEY: "secret",
        }),
      ).toThrowError(/S3_ACCESS_KEY_ID must not be empty/);
    });

    it("falls back to R2_* credentials when neither S3_* credential is set", () => {
      const config = loadConfig(validR2Env);
      expect(config.S3_ACCESS_KEY_ID).toBe("mock-access-key-id");
      expect(config.S3_SECRET_ACCESS_KEY).toBe("mock-secret-access-key");
    });

    it("fails loudly when R2_ACCESS_KEY_ID is set without R2_SECRET_ACCESS_KEY", () => {
      const partialR2 = {
        ...validR2Env,
      };
      delete (partialR2 as Record<string, string | undefined>).R2_SECRET_ACCESS_KEY;

      expect(() => loadConfig(partialR2)).toThrowError(/R2_SECRET_ACCESS_KEY: missing environment variable/);
    });

    it("fails loudly when R2_SECRET_ACCESS_KEY is set without R2_ACCESS_KEY_ID", () => {
      const partialR2 = {
        ...validR2Env,
      };
      delete (partialR2 as Record<string, string | undefined>).R2_ACCESS_KEY_ID;

      expect(() => loadConfig(partialR2)).toThrowError(/R2_ACCESS_KEY_ID: missing environment variable/);
    });

    it("fails when R2_ACCESS_KEY_ID is set and R2_SECRET_ACCESS_KEY is an empty string", () => {
      expect(() =>
        loadConfig({
          ...validR2Env,
          R2_SECRET_ACCESS_KEY: "",
        }),
      ).toThrowError(/R2_SECRET_ACCESS_KEY must not be empty/);
    });

    it("supports ambient credentials: leaves credentials undefined when neither S3_* nor R2_* are set", () => {
      const ambientEnv = {
        ...validBaseEnv,
        S3_BUCKET: "ambient-iam-bucket",
      };
      const config = loadConfig(ambientEnv);
      expect(config.S3_ACCESS_KEY_ID).toBeUndefined();
      expect(config.S3_SECRET_ACCESS_KEY).toBeUndefined();
      expect(config.R2_ACCESS_KEY_ID).toBeUndefined();
      expect(config.R2_SECRET_ACCESS_KEY).toBeUndefined();
    });
  });

  describe("S3_FORCE_PATH_STYLE parsing", () => {
    it("defaults to false when unset or blank whitespace", () => {
      const configDefault = loadConfig(validS3Env);
      expect(configDefault.S3_FORCE_PATH_STYLE).toBe(false);

      const configEmpty = loadConfig({ ...validS3Env, S3_FORCE_PATH_STYLE: "" });
      expect(configEmpty.S3_FORCE_PATH_STYLE).toBe(false);

      const configBlank = loadConfig({ ...validS3Env, S3_FORCE_PATH_STYLE: "   " });
      expect(configBlank.S3_FORCE_PATH_STYLE).toBe(false);
    });

    it("parses truthy values as true (true, TRUE, 1)", () => {
      expect(loadConfig({ ...validS3Env, S3_FORCE_PATH_STYLE: "true" }).S3_FORCE_PATH_STYLE).toBe(true);
      expect(loadConfig({ ...validS3Env, S3_FORCE_PATH_STYLE: "TRUE" }).S3_FORCE_PATH_STYLE).toBe(true);
      expect(loadConfig({ ...validS3Env, S3_FORCE_PATH_STYLE: "1" }).S3_FORCE_PATH_STYLE).toBe(true);
    });

    it("parses falsy values as false (false, FALSE, 0)", () => {
      expect(loadConfig({ ...validS3Env, S3_FORCE_PATH_STYLE: "false" }).S3_FORCE_PATH_STYLE).toBe(false);
      expect(loadConfig({ ...validS3Env, S3_FORCE_PATH_STYLE: "FALSE" }).S3_FORCE_PATH_STYLE).toBe(false);
      expect(loadConfig({ ...validS3Env, S3_FORCE_PATH_STYLE: "0" }).S3_FORCE_PATH_STYLE).toBe(false);
    });

    it("rejects non-boolean strings with a clear error", () => {
      expect(() =>
        loadConfig({
          ...validS3Env,
          S3_FORCE_PATH_STYLE: "not-a-boolean",
        }),
      ).toThrowError(/S3_FORCE_PATH_STYLE must be a boolean \(true or false\)/);
    });
  });
});
