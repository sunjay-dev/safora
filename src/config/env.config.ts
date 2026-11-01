import { z } from "zod";

export const VALID_DESTINATIONS = ["r2", "local"] as const;
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

export interface BaseConfig {
  AGE_RECIPIENT: string;
  LOG_LEVEL: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  RETENTION_DAYS: number;
  BACKUP_PREFIX: string;
  DUMP_TIMEOUT_MS: number;
  TOOL_CHECK_TIMEOUT_MS: number;
  MAX_BUFFER: number;
  DESTINATIONS: DestinationId[];
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
    return ["r2"];
  }

  const segments = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  if (segments.length === 0) {
    return ["r2"];
  }

  const seen = new Set<string>();
  const destinations: DestinationId[] = [];

  for (const segment of segments) {
    if (!VALID_DESTINATIONS.includes(segment as DestinationId)) {
      throw new Error(`Unknown destination "${segment}". Valid destinations are: ${VALID_DESTINATIONS.join(", ")}`);
    }
    if (seen.has(segment)) {
      throw new Error(`Duplicate destination "${segment}"`);
    }
    seen.add(segment);
    destinations.push(segment as DestinationId);
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

  let r2Output: z.infer<typeof R2EnvSchema> | undefined;
  if (destinations.includes("r2")) {
    const r2Result = R2EnvSchema.safeParse(env);
    if (!r2Result.success) {
      issues.push(...r2Result.error.issues);
    } else {
      r2Output = r2Result.data;
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
    ...(r2Output ?? {}),
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
