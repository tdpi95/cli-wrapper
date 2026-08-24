import path from "node:path";

export interface Env {
  apiKey: string;
  port: number;
  cliTimeoutMs: number;
  configPath: string;
  cliWorkdir: string;
  logCaptureContent: boolean;
  /** Absolute path to persist the activity log to, or undefined to keep it in-memory only. */
  logFilePath?: string;
}

const FALSY_VALUES = new Set(["false", "0", "no", "off"]);

/** Accepts "false"/"0"/"no"/"off" (case-insensitive) as false; anything else, including unset, is true. */
function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") return defaultValue;
  return !FALSY_VALUES.has(value.trim().toLowerCase());
}

/**
 * Reads and validates process.env. Exits the process with a clear message if
 * required configuration (the shared bearer token) is missing — this server
 * is meant to be reachable over HTTP, so failing loudly at startup is safer
 * than silently allowing unauthenticated access.
 */
export function loadEnv(): Env {
  const apiKey = process.env.WRAPPER_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    console.error(
      "FATAL: WRAPPER_API_KEY is not set. Refusing to start an HTTP server " +
        "without an auth token. Set WRAPPER_API_KEY in your environment or .env file " +
        "(e.g. WRAPPER_API_KEY=dev-secret npm run dev for local development)."
    );
    process.exit(1);
  }

  const port = Number(process.env.PORT ?? 8787);
  const cliTimeoutMs = Number(process.env.CLI_TIMEOUT_MS ?? 120_000);
  const configPath = path.resolve(process.cwd(), process.env.CONFIG_PATH ?? "./config.json");
  const cliWorkdir = process.env.CLI_WORKDIR ?? path.join(process.cwd(), ".cli-wrapper-workspace");
  const logCaptureContent = parseBooleanEnv(process.env.LOG_CAPTURE_CONTENT, true);
  const logFilePath =
    process.env.LOG_FILE_PATH && process.env.LOG_FILE_PATH.trim() !== ""
      ? path.resolve(process.cwd(), process.env.LOG_FILE_PATH)
      : undefined;

  return { apiKey, port, cliTimeoutMs, configPath, cliWorkdir, logCaptureContent, logFilePath };
}
