import pino from "pino";

let redactionSecret: string | null = null;

export function setRedactionSecret(value: string): void {
  redactionSecret = value;
}

export function sanitize(text: string): string {
  return redactionSecret ? text.split(redactionSecret).join("***MONGODB_URI***") : text;
}

const LOG_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);

function logLevel(): string {
  // GitHub Actions renders a missing repository variable as an empty string.
  const requested = (process.env.LOG_LEVEL ?? "").trim().toLowerCase();
  return LOG_LEVELS.has(requested) ? requested : "info";
}

/** Every log line goes through the URI scrubber on its way out, so the
 *  connection string can never leak even if a call site forgets to sanitize. */
const sanitizedDestination = {
  write(line: string): boolean {
    process.stdout.write(sanitize(line));
    return true;
  },
};

export const logger = pino(
  {
    level: logLevel(),
    base: undefined, // drop pid/hostname — noise in CI logs
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  sanitizedDestination,
);

export function fail(message: string): never {
  throw new Error(sanitize(message));
}
