import * as v from "valibot";

const requiredString = (name: string) =>
  v.pipe(v.string(), v.trim(), v.nonEmpty(`${name} must not be empty`));

const stringWithDefault = (fallback: string) =>
  v.pipe(
    v.optional(v.string(), fallback),
    v.trim(),
    v.transform((raw) => (raw === "" ? fallback : raw)),
  );

const intWithDefault = (
  name: string,
  fallback: number,
  unit: string,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
) =>
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
  v.picklist(
    ["trace", "debug", "info", "warn", "error", "fatal"],
    "LOG_LEVEL must be one of: trace, debug, info, warn, error, fatal",
  ),
);

export const EnvSchema = v.object({
  MONGODB_URI: requiredString("MONGODB_URI"),
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
  AGE_RECIPIENT: v.pipe(
    requiredString("AGE_RECIPIENT"),
    v.startsWith("age1", 'AGE_RECIPIENT must be an age public key starting with "age1"'),
  ),

  LOG_LEVEL: logLevel,
  RETENTION_DAYS: intWithDefault("RETENTION_DAYS", 30, "days", 1, 3650),
  BACKUP_PREFIX: backupPrefix,
  DUMP_TIMEOUT_MS: intWithDefault("DUMP_TIMEOUT_MS", 20 * 60 * 1000, "milliseconds"),
  ENCRYPT_TIMEOUT_MS: intWithDefault("ENCRYPT_TIMEOUT_MS", 10 * 60 * 1000, "milliseconds"),
  TOOL_CHECK_TIMEOUT_MS: intWithDefault("TOOL_CHECK_TIMEOUT_MS", 30 * 1000, "milliseconds"),
  MAX_BUFFER: intWithDefault("MAX_BUFFER", 10 * 1024 * 1024, "bytes"),
});

export type Config = v.InferOutput<typeof EnvSchema>;

export function loadConfig(): Config {
  const result = v.safeParse(EnvSchema, process.env);
  if (!result.success) {
    const seen = new Set<string>();
    const issues = result.issues
      .map((issue) => {
        const name = (issue.path ?? []).map((item) => String(item.key)).join(".") || "(root)";
        if (seen.has(name)) return null;
        seen.add(name);
        const message =
          process.env[name] === undefined ? "missing environment variable" : issue.message;
        return `  - ${name}: ${message}`;
      })
      .filter((line): line is string => line !== null)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return result.output;
}
