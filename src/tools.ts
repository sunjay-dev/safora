import type { Config } from "./config/env.config.js";
import { execDetail, execFileAsync } from "./lib/exec.js";
import { fail } from "./logging.js";

export async function assertToolInstalled(config: Config, command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: config.TOOL_CHECK_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return (stdout || "").split("\n")[0]?.trim() ?? "";
  } catch (err) {
    fail(`Required tool "${command}" is not on PATH or failed to start: ${execDetail(err)}`);
  }
}

/** Preflight toolchain check \u2014 checks mongodump for mongodb, and pg_dump + pg_restore for postgres. */
export async function assertPreflightTools(config: Config): Promise<Record<string, string>> {
  if (config.ENGINE === "mongodb") {
    const mongodump = await assertToolInstalled(config, "mongodump", ["--version"]);
    return { mongodump };
  } else {
    const pg_dump = await assertToolInstalled(config, "pg_dump", ["--version"]);
    const pg_restore = await assertToolInstalled(config, "pg_restore", ["--version"]);
    return { pg_dump, pg_restore };
  }
}
