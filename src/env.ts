import path from "node:path";

/**
 * Only the two values that genuinely can't live in config.json: the path to
 * config.json itself (obviously bootstrap-only — it names the file
 * everything else lives in), and an optional PORT override for deployment
 * setups (containers, process managers) that inject it via env regardless
 * of what's on disk. Everything else that used to be an env var
 * (apiKey/cliTimeoutMs/cliWorkdir/logCaptureContent/logFilePath) now lives
 * in config.json's `settings`, editable from /settings — see types/config.ts.
 */
export interface Env {
  configPath: string;
  /** If set, overrides config.settings.port for this run. */
  portOverride?: number;
}

export function loadEnv(): Env {
  const configPath = path.resolve(process.cwd(), process.env.CONFIG_PATH ?? "./config.json");
  const portOverride = process.env.PORT?.trim() ? Number(process.env.PORT) : undefined;
  return { configPath, portOverride };
}
