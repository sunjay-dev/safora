import { appendFile } from "node:fs/promises";

export async function writeSummary(lines: string[]): Promise<void> {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`, "utf8");
}
