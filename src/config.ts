import * as v from "valibot";

const requiredString = (name: string) =>
  v.pipe(v.string(), v.trim(), v.nonEmpty(`${name} must not be empty`));

// RETENTION_DAYS arrives as a string. GitHub Actions renders a missing repository
// variable as an empty string, so an unset or blank value falls back to "30"
// rather than failing validation.
const retentionDays = v.pipe(
  v.optional(v.string(), "30"),
  v.trim(),
  v.transform((raw) => (raw === "" ? "30" : raw)),
  v.transform((raw) => Number.parseInt(raw, 10)),
  v.check((n) => Number.isInteger(n), "RETENTION_DAYS must be an integer"),
  v.minValue(1, "RETENTION_DAYS must be at least 1"),
  v.maxValue(3650, "RETENTION_DAYS must be at most 3650"),
);

export const EnvSchema = v.object({
  MONGODB_URI: requiredString("MONGODB_URI"),
  R2_ACCOUNT_ID: requiredString("R2_ACCOUNT_ID"),
  R2_ACCESS_KEY_ID: requiredString("R2_ACCESS_KEY_ID"),
  R2_SECRET_ACCESS_KEY: requiredString("R2_SECRET_ACCESS_KEY"),
  R2_BUCKET: requiredString("R2_BUCKET"),
  AGE_RECIPIENT: v.pipe(
    requiredString("AGE_RECIPIENT"),
    v.startsWith("age1", 'AGE_RECIPIENT must be an age public key starting with "age1"'),
  ),
  RETENTION_DAYS: retentionDays,
});

/** Validated configuration — keys keep their environment variable names. */
export type Config = v.InferOutput<typeof EnvSchema>;

/** Parse and validate the environment; throws one readable error listing every problem. */
export function loadConfig(): Config {
  const result = v.safeParse(EnvSchema, process.env);
  if (!result.success) {
    const issues = result.issues
      .map((issue) => {
        const name = (issue.path ?? []).map((item) => String(item.key)).join(".") || "(root)";
        // Valibot's default missing-key message is "Invalid key: Expected ... but
        // received undefined"; render something clearer when the var is absent.
        const message =
          process.env[name] === undefined ? "missing environment variable" : issue.message;
        return `  - ${name}: ${message}`;
      })
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return result.output;
}
