import { describe, expect, it } from "vitest";
import { buildApp, runCli } from "../helpers/cli-runner.js";

describe("CLI subprocess runner helper", () => {
  it("builds the application artifact dist/main.js successfully", async () => {
    await expect(buildApp()).resolves.toBeUndefined();
  });

  it("executes node dist/main.js, captures Pino structured logs and non-zero exit code on invalid configuration", async () => {
    const result = await runCli({
      env: {
        // Clear all configuration to trigger immediate validation failure
        MONGODB_URI: "",
        POSTGRESQL_URI: "",
        S3_BUCKET: "",
        AGE_RECIPIENT: "",
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.durationMs).toBeGreaterThan(0);

    // Verify stdout captures structured JSON log entries
    expect(result.logs.length).toBeGreaterThan(0);
    const configErrorLogs = result.findLogs((log) => log.msg === "configuration error" || log.level === 50);
    expect(configErrorLogs.length).toBeGreaterThan(0);
  });

  it("enforces configurable timeout when subprocess execution exceeds limit", async () => {
    // When executing with an impossibly small timeout, it should reject with a timeout error
    await expect(
      runCli({
        env: {
          MONGODB_URI: "",
        },
        timeoutMs: 1, // 1ms timeout will trigger timeout handling
      }),
    ).rejects.toThrow(/timed out/i);
  });
});
