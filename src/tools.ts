import type { Config } from "./config/env.config.js";
import { type ExecFileFn, execDetail, execFileAsync } from "./lib/exec.js";
import { fail } from "./logging.js";

export async function assertToolInstalled(config: Config, command: string, args: string[], execFile: ExecFileFn = execFileAsync): Promise<string> {
  try {
    const { stdout } = await execFile(command, args, {
      timeout: config.TOOL_CHECK_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return (stdout || "").split("\n")[0]?.trim() ?? "";
  } catch (err) {
    fail(`Required tool "${command}" is not on PATH or failed to start: ${execDetail(err)}`);
  }
}

/** Preflight toolchain check — checks mongodump for mongodb, and pg_dump + pg_restore for postgres. */
export async function assertPreflightTools(config: Config, execFile: ExecFileFn = execFileAsync): Promise<Record<string, string>> {
  if (config.ENGINE === "mongodb") {
    const mongodump = await assertToolInstalled(config, "mongodump", ["--version"], execFile);
    return { mongodump };
  } else {
    const pg_dump = await assertToolInstalled(config, "pg_dump", ["--version"], execFile);
    const pg_restore = await assertToolInstalled(config, "pg_restore", ["--version"], execFile);
    return { pg_dump, pg_restore };
  }
}
