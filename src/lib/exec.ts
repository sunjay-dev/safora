import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

export function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `…${text.slice(-maxChars)}`;
}

export function execDetail(err: unknown): string {
  const e = err as Error & { stdout?: string; stderr?: string };
  const parts = [e?.stderr, e?.stdout, e?.message]
    .map((part) => (part ? String(part) : ""))
    .filter(Boolean);
  return tail(parts.join("\n"), 4000);
}
