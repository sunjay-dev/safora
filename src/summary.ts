import { appendFile } from "node:fs/promises";
import { failedOutcomes, type DestinationOutcome } from "./destinations/deliver.js";

/** One summary block per destination, with failures called out at the end. */
export function renderSummary(outcomes: readonly DestinationOutcome[], retentionDays: number, objectKey: string): string[] {
  const lines = ["### MongoDB backup summary", ""];

  for (const outcome of outcomes) {
    lines.push(`#### ${outcome.id}`);

    if (outcome.delivery) {
      lines.push(`- Object: \`${outcome.delivery.location}\``);
      lines.push(`- Encrypted size: ${outcome.delivery.bytes} bytes`);
      lines.push(`- SHA-256: \`${outcome.delivery.sha256}\``);
    } else {
      lines.push(`- Object key: \`${objectKey}\``);
    }

    if (outcome.failure) {
      const stage = outcome.failure.stage === "delivery" ? "Delivery" : "Retention";
      lines.push(`- ${stage} failed: ${outcome.failure.message}`);
    } else {
      lines.push(`- Retention: ${outcome.pruned.length} object(s) pruned (${retentionDays}-day policy)`);
      if (outcome.pruned.length > 0) {
        lines.push(`  - ${outcome.pruned.map((key) => `\`${key}\``).join(", ")}`);
      }
    }

    lines.push("");
  }

  const failed = failedOutcomes(outcomes).map((outcome) => `\`${outcome.id}\``);
  if (failed.length > 0) {
    lines.push(`**Failed destinations:** ${failed.join(", ")}`);
  }

  return lines;
}

export async function writeSummary(lines: string[]): Promise<void> {
  const text = `${lines.join("\n")}\n`;
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    await appendFile(summaryPath, text, "utf8");
    return;
  }
  process.stdout.write(text);
}
