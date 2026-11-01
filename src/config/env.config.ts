import { z } from "zod";

export const ACCEPTED_DESTINATIONS = ["s3", "r2", "local"] as const;
export type AcceptedDestination = (typeof ACCEPTED_DESTINATIONS)[number];

export const VALID_DESTINATIONS = ["s3", "local"] as const;
export type DestinationId = (typeof VALID_DESTINATIONS)[number];

export const VALID_ENGINES = ["mongodb", "postgres"] as const;
export type EngineId = (typeof VALID_ENGINES)[number];

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const requiredString = (name: string) => z.string().trim().min(1, `${name} must not be empty`);

const stringWithDefault = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((raw) => {
      const trimmed = raw.trim();
      return trimmed === "" ? fallback : trimmed;
    });

const intWithDefault = (name: string, fallback: number, unit: string, min = 1, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .default(String(fallback))
    .transform((raw) => {
      const trimmed = raw.trim();
      return trimmed === "" ? String(fallback) : trimmed;
    })
    .transform(Number)
    .refine((n) => Number.isInteger(n) && n > 0, {
      message: `${name} must be a positive integer (${unit})`,
    })
    .refine((n) => n >= min, {
      message: `${name} must be at least ${min}`,
    })
    .refine((n) => n <= max, {
      message: `${name} must be at most ${max}`,
    });

const backupPrefix = stringWithDefault("backups/").transform((raw) => (raw.endsWith("/") ? raw : `${raw}/`));

const logLevel = stringWithDefault("info")
  .transform((raw) => raw.toLowerCase())
  .refine((raw): raw is LogLevel => LOG_LEVELS.includes(raw as LogLevel), {
    message: "LOG_LEVEL must be one of: trace, debug, info, warn, error, fatal",
  });

/** A PostgreSQL connection URI: postgres:// or postgresql://, validated without ever echoing the value. */
const postgresqlUri = requiredString("POSTGRESQL_URI").refine(
  (raw) => {
    try {
      const url = new URL(raw);
      if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
        return false;
      }
      // Require either a host or a database name so bare "postgresql://" is rejected.
      return url.hostname !== "" || (url.pathname !== "" && url.pathname !== "/");
    } catch {
      return false;
    }
  },
  {
    message: "POSTGRESQL_URI must be a valid PostgreSQL connection URI (postgres:// or postgresql://)",
  },
);

export const CommonEnvSchema = z.object({
  AGE_RECIPIENT: requiredString("AGE_RECIPIENT").startsWith("age1", 'AGE_RECIPIENT must be an age public key starting with "age1"'),

  LOG_LEVEL: logLevel,
  RETENTION_DAYS: intWithDefault("RETENTION_DAYS", 30, "days", 1, 3650),
  BACKUP_PREFIX: backupPrefix,
  DUMP_TIMEOUT_MS: intWithDefault("DUMP_TIMEOUT_MS", 20 * 60 * 1000, "milliseconds"),
  TOOL_CHECK_TIMEOUT_MS: intWithDefault("TOOL_CHECK_TIMEOUT_MS", 30 * 1000, "milliseconds"),
  MAX_BUFFER: intWithDefault("MAX_BUFFER", 10 * 1024 * 1024, "bytes"),
});

export const MongodbEnvSchema = z.object({
  MONGODB_URI: requiredString("MONGODB_URI"),
});

export const PostgresEnvSchema = z.object({
  POSTGRESQL_URI: postgresqlUri,
});

/**
 * Parses PG_DB_BLOCKLIST: a comma-separated list of glob patterns.
 * Each pattern is trimmed; blank entries are ignored.
 * Supports * as a wildcard (e.g. "prisma_migrate_shadow_db_*,*_test").
 * Returns an empty array when the variable is unset or blank (= no blocklist, back up all databases).
 */
export function parseDbBlocklist(raw?: string): string[] {
  if (raw === undefined || raw.trim() === "") {
    return [];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function pickBlocklist(specific?: string, fallback?: string): string | undefined {
  const specificTrimmed = specific?.trim();
  if (specificTrimmed && specificTrimmed.length > 0) {
    return specificTrimmed;
  }
  const fallbackTrimmed = fallback?.trim();
  if (fallbackTrimmed && fallbackTrimmed.length > 0) {
    return fallbackTrimmed;
  }
  return undefined;
}

export const R2EnvSchema = z.object({
  R2_ENDPOINT: z
    .string()
    .trim()
    .min(1, "R2_ENDPOINT must not be empty")
    .startsWith("https://", "R2_ENDPOINT must use https://")
    .url("R2_ENDPOINT must be a valid URL")
    .transform((raw) => raw.replace(/\/+$/, "")),
  R2_ACCESS_KEY_ID: requiredString("R2_ACCESS_KEY_ID"),
  R2_SECRET_ACCESS_KEY: requiredString("R2_SECRET_ACCESS_KEY"),
  R2_BUCKET: requiredString("R2_BUCKET"),
});

export const LocalEnvSchema = z.object({
  LOCAL_BACKUP_DIR: requiredString("LOCAL_BACKUP_DIR"),
});

export const S3EnvSchema = z
  .object({
    S3_BUCKET: z.string().optional(),
    R2_BUCKET: z.string().optional(),
    S3_ENDPOINT: z.string().optional(),
    R2_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    // 1. S3_BUCKET / R2_BUCKET
    const s3BucketRaw = env.S3_BUCKET;
    const r2BucketRaw = env.R2_BUCKET;
    const s3Bucket = s3BucketRaw?.trim();
    const r2Bucket = r2BucketRaw?.trim();

    const hasS3Bucket = s3Bucket !== undefined && s3Bucket !== "";
    const hasR2Bucket = r2Bucket !== undefined && r2Bucket !== "";

    if (!hasS3Bucket && !hasR2Bucket) {
      if (s3BucketRaw !== undefined && s3Bucket === "") {
        ctx.addIssue({
          code: "custom",
          path: ["S3_BUCKET"],
          message: "S3_BUCKET must not be empty",
        });
      } else if (s3BucketRaw === undefined && r2BucketRaw !== undefined && r2Bucket === "") {
        ctx.addIssue({
          code: "custom",
          path: ["R2_BUCKET"],
          message: "R2_BUCKET must not be empty",
        });
      } else {
        ctx.addIssue({
          code: "custom",
          path: ["S3_BUCKET"],
          message: "S3_BUCKET must not be empty",
        });
      }
    }

    // 2. S3_ENDPOINT / R2_ENDPOINT
    const s3EndpointRaw = env.S3_ENDPOINT;
    const r2EndpointRaw = env.R2_ENDPOINT;
    const s3Endpoint = s3EndpointRaw?.trim();
    const r2Endpoint = r2EndpointRaw?.trim();

    if (s3Endpoint !== undefined && s3Endpoint !== "") {
      try {
        const url = new URL(s3Endpoint);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          ctx.addIssue({
            code: "custom",
            path: ["S3_ENDPOINT"],
            message: "S3_ENDPOINT must use http:// or https://",
          });
        }
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["S3_ENDPOINT"],
          message: "S3_ENDPOINT must be a valid URL",
        });
      }
    } else if (r2Endpoint !== undefined && r2Endpoint !== "") {
      try {
        const url = new URL(r2Endpoint);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          ctx.addIssue({
            code: "custom",
            path: ["R2_ENDPOINT"],
            message: "R2_ENDPOINT must use http:// or https://",
          });
        }
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["R2_ENDPOINT"],
          message: "R2_ENDPOINT must be a valid URL",
        });
      }
    }

    // 3. Credentials boundary and fallback
    const s3KeyRaw = env.S3_ACCESS_KEY_ID;
    const s3SecretRaw = env.S3_SECRET_ACCESS_KEY;
    const s3KeyTrimmed = s3KeyRaw?.trim();
    const s3SecretTrimmed = s3SecretRaw?.trim();

    const s3KeyDefined = s3KeyRaw !== undefined;
    const s3SecretDefined = s3SecretRaw !== undefined;
    const hasS3Key = Boolean(s3KeyTrimmed && s3KeyTrimmed.length > 0);
    const hasS3Secret = Boolean(s3SecretTrimmed && s3SecretTrimmed.length > 0);

    if (hasS3Key || hasS3Secret || (s3KeyDefined && s3KeyTrimmed === "") || (s3SecretDefined && s3SecretTrimmed === "")) {
      // S3 prefix active: both required, fails loudly if only one is set
      if (!hasS3Key) {
        ctx.addIssue({
          code: "custom",
          path: ["S3_ACCESS_KEY_ID"],
          message: !s3KeyDefined ? "missing environment variable" : "S3_ACCESS_KEY_ID must not be empty",
        });
      }
      if (!hasS3Secret) {
        ctx.addIssue({
          code: "custom",
          path: ["S3_SECRET_ACCESS_KEY"],
          message: !s3SecretDefined ? "missing environment variable" : "S3_SECRET_ACCESS_KEY must not be empty",
        });
      }
    } else {
      // Check R2 credentials fallback
      const r2KeyRaw = env.R2_ACCESS_KEY_ID;
      const r2SecretRaw = env.R2_SECRET_ACCESS_KEY;
      const r2KeyTrimmed = r2KeyRaw?.trim();
      const r2SecretTrimmed = r2SecretRaw?.trim();

      const r2KeyDefined = r2KeyRaw !== undefined;
      const r2SecretDefined = r2SecretRaw !== undefined;
      const hasR2Key = Boolean(r2KeyTrimmed && r2KeyTrimmed.length > 0);
      const hasR2Secret = Boolean(r2SecretTrimmed && r2SecretTrimmed.length > 0);

      if (hasR2Key || hasR2Secret || (r2KeyDefined && r2KeyTrimmed === "") || (r2SecretDefined && r2SecretTrimmed === "")) {
        if (!hasR2Key) {
          ctx.addIssue({
            code: "custom",
            path: ["R2_ACCESS_KEY_ID"],
            message: !r2KeyDefined ? "missing environment variable" : "R2_ACCESS_KEY_ID must not be empty",
          });
        }
        if (!hasR2Secret) {
          ctx.addIssue({
            code: "custom",
            path: ["R2_SECRET_ACCESS_KEY"],
            message: !r2SecretDefined ? "missing environment variable" : "R2_SECRET_ACCESS_KEY must not be empty",
          });
        }
      }
    }

    // 4. S3_FORCE_PATH_STYLE
    const forcePathStyleRaw = env.S3_FORCE_PATH_STYLE?.trim();
    if (forcePathStyleRaw !== undefined && forcePathStyleRaw !== "") {
      const lower = forcePathStyleRaw.toLowerCase();
      if (lower !== "true" && lower !== "1" && lower !== "false" && lower !== "0") {
        ctx.addIssue({
          code: "custom",
          path: ["S3_FORCE_PATH_STYLE"],
          message: "S3_FORCE_PATH_STYLE must be a boolean (true or false)",
        });
      }
    }
  })
  .transform((env) => {
    // 1. Bucket resolution
    const s3Bucket = env.S3_BUCKET?.trim();
    const r2Bucket = env.R2_BUCKET?.trim();
    const resolvedBucket = s3Bucket && s3Bucket !== "" ? s3Bucket : (r2Bucket && r2Bucket !== "" ? r2Bucket : undefined)!;

    // 2. Endpoint resolution
    const s3Endpoint = env.S3_ENDPOINT?.trim();
    const r2Endpoint = env.R2_ENDPOINT?.trim();
    let resolvedEndpoint: string | undefined;
    if (s3Endpoint && s3Endpoint !== "") {
      resolvedEndpoint = s3Endpoint.replace(/\/+$/, "");
    } else if (r2Endpoint && r2Endpoint !== "") {
      resolvedEndpoint = r2Endpoint.replace(/\/+$/, "");
    }

    // 3. Region resolution
    const s3Region = env.S3_REGION?.trim();
    let resolvedRegion: string | undefined;
    if (s3Region && s3Region !== "") {
      resolvedRegion = s3Region;
    } else {
      const hasLegacyR2 = Boolean(
        (env.R2_BUCKET && env.R2_BUCKET.trim() !== "") ||
        (env.R2_ENDPOINT && env.R2_ENDPOINT.trim() !== "") ||
        (env.R2_ACCESS_KEY_ID && env.R2_ACCESS_KEY_ID.trim() !== "") ||
        (env.R2_SECRET_ACCESS_KEY && env.R2_SECRET_ACCESS_KEY.trim() !== ""),
      );

      let isR2Endpoint = false;
      if (resolvedEndpoint) {
        try {
          const url = new URL(resolvedEndpoint);
          if (url.hostname.endsWith(".r2.cloudflarestorage.com") || url.hostname === "r2.cloudflarestorage.com") {
            isR2Endpoint = true;
          }
        } catch {
          // ignore
        }
      }

      if (hasLegacyR2 || isR2Endpoint) {
        resolvedRegion = "auto";
      } else {
        resolvedRegion = undefined;
      }
    }

    // 4. Credentials resolution
    const s3KeyTrimmed = env.S3_ACCESS_KEY_ID?.trim();
    const s3SecretTrimmed = env.S3_SECRET_ACCESS_KEY?.trim();
    const r2KeyTrimmed = env.R2_ACCESS_KEY_ID?.trim();
    const r2SecretTrimmed = env.R2_SECRET_ACCESS_KEY?.trim();

    let resolvedAccessKeyId: string | undefined;
    let resolvedSecretAccessKey: string | undefined;

    if (s3KeyTrimmed && s3KeyTrimmed !== "" && s3SecretTrimmed && s3SecretTrimmed !== "") {
      resolvedAccessKeyId = s3KeyTrimmed;
      resolvedSecretAccessKey = s3SecretTrimmed;
    } else if (r2KeyTrimmed && r2KeyTrimmed !== "" && r2SecretTrimmed && r2SecretTrimmed !== "") {
      resolvedAccessKeyId = r2KeyTrimmed;
      resolvedSecretAccessKey = r2SecretTrimmed;
    }

    // 5. ForcePathStyle resolution
    let resolvedForcePathStyle = false;
    const forcePathStyleRaw = env.S3_FORCE_PATH_STYLE?.trim();
    if (forcePathStyleRaw !== undefined && forcePathStyleRaw !== "") {
      const lower = forcePathStyleRaw.toLowerCase();
      if (lower === "true" || lower === "1") {
        resolvedForcePathStyle = true;
      }
    }

    return {
      S3_BUCKET: resolvedBucket,
      S3_ENDPOINT: resolvedEndpoint,
      S3_REGION: resolvedRegion,
      S3_ACCESS_KEY_ID: resolvedAccessKeyId,
      S3_SECRET_ACCESS_KEY: resolvedSecretAccessKey,
      S3_FORCE_PATH_STYLE: resolvedForcePathStyle,
      // Backwards compatibility aliases
      R2_BUCKET: resolvedBucket,
      R2_ENDPOINT: resolvedEndpoint,
      R2_ACCESS_KEY_ID: resolvedAccessKeyId,
      R2_SECRET_ACCESS_KEY: resolvedSecretAccessKey,
    };
  });

export interface BaseConfig {
  AGE_RECIPIENT: string;
  LOG_LEVEL: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  RETENTION_DAYS: number;
  BACKUP_PREFIX: string;
  DUMP_TIMEOUT_MS: number;
  TOOL_CHECK_TIMEOUT_MS: number;
  MAX_BUFFER: number;
  DESTINATIONS: DestinationId[];
  S3_BUCKET?: string;
  S3_ENDPOINT?: string;
  S3_REGION?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_FORCE_PATH_STYLE?: boolean;
  R2_ENDPOINT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
  LOCAL_BACKUP_DIR?: string;
}

export type MongodbConfig = BaseConfig & { ENGINE: "mongodb"; MONGODB_URI: string; MONGODB_DB_BLOCKLIST?: string[] };
export type PostgresConfig = BaseConfig & { ENGINE: "postgres"; POSTGRESQL_URI: string; PG_DB_BLOCKLIST?: string[] };
export type Config = MongodbConfig | PostgresConfig;

export function parseEngine(raw?: string): EngineId {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") {
    return "mongodb";
  }

  if (!VALID_ENGINES.includes(value as EngineId)) {
    throw new Error(`Unknown engine "${value}". Valid engines are: ${VALID_ENGINES.join(", ")}`);
  }
  return value as EngineId;
}

export function parseDestinations(raw?: string): DestinationId[] {
  if (raw === undefined || raw.trim() === "") {
    return ["s3"];
  }

  const segments = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  if (segments.length === 0) {
    return ["s3"];
  }

  const seen = new Set<string>();
  const destinations: DestinationId[] = [];

  for (const segment of segments) {
    if (!ACCEPTED_DESTINATIONS.includes(segment as AcceptedDestination)) {
      throw new Error(`Unknown destination "${segment}". Valid destinations are: ${ACCEPTED_DESTINATIONS.join(", ")}`);
    }

    const normalized: DestinationId = segment === "r2" ? "s3" : (segment as DestinationId);

    if (seen.has(normalized)) {
      throw new Error(`Duplicate destination "${segment}"`);
    }

    seen.add(normalized);
    destinations.push(normalized);
  }

  return destinations;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const issues: Array<{ path?: Array<unknown>; message: string }> = [];

  let commonOutput: z.infer<typeof CommonEnvSchema> | undefined;
  const commonResult = CommonEnvSchema.safeParse(env);
  if (!commonResult.success) {
    issues.push(...commonResult.error.issues);
  } else {
    commonOutput = commonResult.data;
  }

  let mongodbOutput: z.infer<typeof MongodbEnvSchema> | undefined;
  let postgresOutput: z.infer<typeof PostgresEnvSchema> | undefined;

  let engine: EngineId | undefined;
  try {
    engine = parseEngine(env.ENGINE);
  } catch (err) {
    issues.push({
      path: ["ENGINE"],
      message: err instanceof Error ? err.message : String(err),
    });
  }

  if (engine === "mongodb") {
    const result = MongodbEnvSchema.safeParse(env);
    if (!result.success) {
      issues.push(...result.error.issues);
    } else {
      mongodbOutput = result.data;
    }
  } else if (engine === "postgres") {
    const result = PostgresEnvSchema.safeParse(env);
    if (!result.success) {
      issues.push(...result.error.issues);
    } else {
      postgresOutput = result.data;
    }
  }

  let destinations: DestinationId[] = [];
  try {
    destinations = parseDestinations(env.DESTINATIONS);
  } catch (err) {
    issues.push({
      path: ["DESTINATIONS"],
      message: err instanceof Error ? err.message : String(err),
    });
  }

  let s3Output: z.infer<typeof S3EnvSchema> | undefined;
  if (destinations.includes("s3")) {
    const s3Result = S3EnvSchema.safeParse(env);
    if (!s3Result.success) {
      issues.push(...s3Result.error.issues);
    } else {
      s3Output = s3Result.data;
    }
  }

  let localOutput: z.infer<typeof LocalEnvSchema> | undefined;
  if (destinations.includes("local")) {
    const localResult = LocalEnvSchema.safeParse(env);
    if (!localResult.success) {
      issues.push(...localResult.error.issues);
    } else {
      localOutput = localResult.data;
    }
  }

  if (issues.length > 0) {
    const seen = new Set<string>();
    const errorLines = issues
      .map((issue) => {
        const name = (issue.path ?? []).map((item) => String(item)).join(".") || "(root)";
        if (seen.has(name)) return null;
        seen.add(name);
        const message = env[name] === undefined ? "missing environment variable" : issue.message;
        return `  - ${name}: ${message}`;
      })
      .filter((line): line is string => line !== null)
      .join("\n");
    throw new Error(`Invalid configuration:\n${errorLines}`);
  }

  const base = {
    ...commonOutput!,
    DESTINATIONS: destinations,
    ...(s3Output ?? {}),
    ...(localOutput ?? {}),
  };

  if (engine === "mongodb") {
    return {
      ...base,
      ENGINE: "mongodb",
      ...mongodbOutput!,
      MONGODB_DB_BLOCKLIST: parseDbBlocklist(pickBlocklist(env.MONGODB_DB_BLOCKLIST, env.DB_BLOCKLIST)),
    };
  }
  if (engine === "postgres") {
    return {
      ...base,
      ENGINE: "postgres",
      ...postgresOutput!,
      PG_DB_BLOCKLIST: parseDbBlocklist(pickBlocklist(env.PG_DB_BLOCKLIST, env.DB_BLOCKLIST)),
    };
  }
  throw new Error("Invalid configuration:\n  - ENGINE: missing environment variable");
}
