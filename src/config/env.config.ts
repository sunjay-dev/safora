import * as v from "valibot";

export const VALID_DESTINATIONS = ["r2", "local"] as const;
export type Destination = (typeof VALID_DESTINATIONS)[number];

const requiredString = (name: string) => v.pipe(v.string(), v.trim(), v.nonEmpty(`${name} must not be empty`));

const stringWithDefault = (fallback: string) =>
  v.pipe(
    v.optional(v.string(), fallback),
    v.trim(),
    v.transform((raw) => (raw === "" ? fallback : raw)),
  );

const intWithDefault = (name: string, fallback: number, unit: string, min = 1, max = Number.MAX_SAFE_INTEGER) =>
  v.pipe(
    v.optional(v.string(), String(fallback)),
    v.trim(),
    v.transform((raw) => (raw === "" ? String(fallback) : raw)),
    v.transform(Number),
    v.check((n) => Number.isInteger(n) && n > 0, `${name} must be a positive integer (${unit})`),
    v.minValue(min, `${name} must be at least ${min}`),
    v.maxValue(max, `${name} must be at most ${max}`),
  );

const backupPrefix = v.pipe(
  stringWithDefault("backups/"),
  v.transform((raw) => (raw.endsWith("/") ? raw : `${raw}/`)),
);

const logLevel = v.pipe(
  stringWithDefault("info"),
  v.transform((raw) => raw.toLowerCase()),
  v.picklist(["trace", "debug", "info", "warn", "error", "fatal"], "LOG_LEVEL must be one of: trace, debug, info, warn, error, fatal"),
);

export const BaseEnvSchema = v.object({
  MONGODB_URI: requiredString("MONGODB_URI"),
  AGE_RECIPIENT: v.pipe(requiredString("AGE_RECIPIENT"), v.startsWith("age1", 'AGE_RECIPIENT must be an age public key starting with "age1"')),

  LOG_LEVEL: logLevel,
  RETENTION_DAYS: intWithDefault("RETENTION_DAYS", 30, "days", 1, 3650),
  BACKUP_PREFIX: backupPrefix,
  DUMP_TIMEOUT_MS: intWithDefault("DUMP_TIMEOUT_MS", 20 * 60 * 1000, "milliseconds"),
  ENCRYPT_TIMEOUT_MS: intWithDefault("ENCRYPT_TIMEOUT_MS", 10 * 60 * 1000, "milliseconds"),
  TOOL_CHECK_TIMEOUT_MS: intWithDefault("TOOL_CHECK_TIMEOUT_MS", 30 * 1000, "milliseconds"),
  MAX_BUFFER: intWithDefault("MAX_BUFFER", 10 * 1024 * 1024, "bytes"),
});

export const R2EnvSchema = v.object({
  R2_ENDPOINT: v.pipe(
    v.string(),
    v.trim(),
    v.nonEmpty("R2_ENDPOINT must not be empty"),
    v.startsWith("https://", "R2_ENDPOINT must use https://"),
    v.url("R2_ENDPOINT must be a valid URL"),
    v.transform((raw) => raw.replace(/\/+$/, "")),
  ),
  R2_ACCESS_KEY_ID: requiredString("R2_ACCESS_KEY_ID"),
  R2_SECRET_ACCESS_KEY: requiredString("R2_SECRET_ACCESS_KEY"),
  R2_BUCKET: requiredString("R2_BUCKET"),
});

export const LocalEnvSchema = v.object({
  LOCAL_BACKUP_DIR: requiredString("LOCAL_BACKUP_DIR"),
});

export const EnvSchema = v.object({
  ...BaseEnvSchema.entries,
  DESTINATIONS: v.optional(v.string()),
  R2_ENDPOINT: v.optional(v.string()),
  R2_ACCESS_KEY_ID: v.optional(v.string()),
  R2_SECRET_ACCESS_KEY: v.optional(v.string()),
  R2_BUCKET: v.optional(v.string()),
  LOCAL_BACKUP_DIR: v.optional(v.string()),
});

export interface BaseConfig {
  MONGODB_URI: string;
  AGE_RECIPIENT: string;
  LOG_LEVEL: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  RETENTION_DAYS: number;
  BACKUP_PREFIX: string;
  DUMP_TIMEOUT_MS: number;
  ENCRYPT_TIMEOUT_MS: number;
  TOOL_CHECK_TIMEOUT_MS: number;
  MAX_BUFFER: number;
  DESTINATIONS: Destination[];
}

export interface Config extends BaseConfig {
  R2_ENDPOINT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
  LOCAL_BACKUP_DIR?: string;
}

export function parseDestinations(raw?: string): Destination[] {
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
  const destinations: Destination[] = [];

  for (const segment of segments) {
    if (!VALID_DESTINATIONS.includes(segment as Destination)) {
      throw new Error(`Unknown destination "${segment}". Valid destinations are: ${VALID_DESTINATIONS.join(", ")}`);
    }
    if (seen.has(segment)) {
      throw new Error(`Duplicate destination "${segment}"`);
    }
    seen.add(segment);
    destinations.push(segment as Destination);
  }

  return destinations;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const issues: Array<{ path?: Array<{ key: unknown }>; message: string }> = [];

  let baseOutput: v.InferOutput<typeof BaseEnvSchema> | undefined;
  const baseResult = v.safeParse(BaseEnvSchema, env);
  if (!baseResult.success) {
    issues.push(...baseResult.issues);
  } else {
    baseOutput = baseResult.output;
  }

  let destinations: Destination[] = [];
  try {
    destinations = parseDestinations(env.DESTINATIONS);
  } catch (err) {
    issues.push({
      path: [{ key: "DESTINATIONS" }],
      message: err instanceof Error ? err.message : String(err),
    });
  }

  let r2Output: v.InferOutput<typeof R2EnvSchema> | undefined;
  if (destinations.includes("r2")) {
    const r2Result = v.safeParse(R2EnvSchema, env);
    if (!r2Result.success) {
      issues.push(...r2Result.issues);
    } else {
      r2Output = r2Result.output;
    }
  }

  let localOutput: v.InferOutput<typeof LocalEnvSchema> | undefined;
  if (destinations.includes("local")) {
    const localResult = v.safeParse(LocalEnvSchema, env);
    if (!localResult.success) {
      issues.push(...localResult.issues);
    } else {
      localOutput = localResult.output;
    }
  }

  if (issues.length > 0) {
    const seen = new Set<string>();
    const errorLines = issues
      .map((issue) => {
        const name = (issue.path ?? []).map((item) => String(item.key)).join(".") || "(root)";
        if (seen.has(name)) return null;
        seen.add(name);
        const message = env[name] === undefined ? "missing environment variable" : issue.message;
        return `  - ${name}: ${message}`;
      })
      .filter((line): line is string => line !== null)
      .join("\n");
    throw new Error(`Invalid configuration:\n${errorLines}`);
  }

  return {
    ...baseOutput!,
    DESTINATIONS: destinations,
    ...(r2Output ?? {}),
    ...(localOutput ?? {}),
  };
}
