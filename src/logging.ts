import pino from "pino";

export interface RedactionSecret {
  name: string;
  value: string;
}

let redactionSecrets: RedactionSecret[] = [];

export function setRedactionSecrets(secrets: readonly RedactionSecret[]): void {
  redactionSecrets = secrets.filter((secret) => secret.value !== "").sort((a, b) => b.value.length - a.value.length);
}

export function sanitize(text: string): string {
  let sanitized = text;
  for (const { name, value } of redactionSecrets) {
    sanitized = sanitized.split(value).join(`***${name}***`);
  }
  return sanitized;
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
    level: "info", // main() applies LOG_LEVEL from the validated config
    base: undefined, // drop pid/hostname — noise in CI logs
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  sanitizedDestination,
);

export function fail(message: string): never {
  throw new Error(sanitize(message));
}
