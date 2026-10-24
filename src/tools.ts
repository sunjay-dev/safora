import type { Config } from "./config/env.config.js";
import { execDetail, execFileAsync } from "./lib/exec.js";
import { fail } from "./logging.js";

export async function assertToolInstalled(
  config: Config,
  command: string,
  args: string[],
): Promise<string> {
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
