import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CliLogEntry {
  level?: number;
  time?: string | number;
  msg?: string;
  [key: string]: unknown;
}

export interface CliExecutionResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  logs: CliLogEntry[];
  findLogs: (predicateOrMsg: string | ((entry: CliLogEntry) => boolean)) => CliLogEntry[];
}

export interface CliRunOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  cwd?: string;
  ensureBuild?: boolean;
}

const PROJECT_ROOT = resolve(__dirname, "../..");
const MAIN_JS_PATH = resolve(PROJECT_ROOT, "dist/main.js");

let buildPromise: Promise<void> | null = null;

/**
 * Builds the project using `pnpm run build` to exercise the exact production artifact `dist/main.js`.
 */
export async function buildApp(cwd = PROJECT_ROOT): Promise<void> {
  if (!buildPromise) {
    buildPromise = (async () => {
      await execFileAsync("pnpm", ["run", "build"], { cwd });
    })();
  }
  return buildPromise;
}

/**
 * Executes `node dist/main.js` as an un-mocked child process with configured environment variables.
 */
export async function runCli(options: CliRunOptions = {}): Promise<CliExecutionResult> {
  const cwd = options.cwd ?? PROJECT_ROOT;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const shouldBuild = options.ensureBuild ?? !existsSync(MAIN_JS_PATH);

  if (shouldBuild) {
    await buildApp(cwd);
  }

  const startTime = Date.now();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
  };

  return new Promise<CliExecutionResult>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [MAIN_JS_PATH], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 2000);
      killTimer.unref();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;

      if (timedOut) {
        const timeoutError = new Error(`Subprocess timed out after ${timeoutMs}ms.\nStdout: ${stdout}\nStderr: ${stderr}`);
        (timeoutError as unknown as { stdout: string; stderr: string; timedOut: boolean }).stdout = stdout;
        (timeoutError as unknown as { stdout: string; stderr: string; timedOut: boolean }).stderr = stderr;
        (timeoutError as unknown as { stdout: string; stderr: string; timedOut: boolean }).timedOut = true;
        rejectPromise(timeoutError);
        return;
      }

      // Parse structured JSON logs (Pino lines) from stdout
      const logs: CliLogEntry[] = [];
      const lines = stdout.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
          continue;
        }
        try {
          const parsed = JSON.parse(trimmed) as CliLogEntry;
          logs.push(parsed);
        } catch {
          // Ignore lines that look like JSON but fail parsing
        }
      }

      const findLogs = (predicateOrMsg: string | ((entry: CliLogEntry) => boolean)): CliLogEntry[] => {
        if (typeof predicateOrMsg === "string") {
          return logs.filter((log) => log.msg === predicateOrMsg);
        }
        return logs.filter(predicateOrMsg);
      };

      resolvePromise({
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs,
        logs,
        findLogs,
      });
    });
  });
}
