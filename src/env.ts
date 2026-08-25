import path from "node:path";

/**
 * Only the values that genuinely can't live in config.json: the path to
 * config.json itself (obviously bootstrap-only — it names the file
 * everything else lives in), an optional PORT override for the API surface
 * (deployment setups — containers, process managers — that inject it via env
 * regardless of what's on disk), and the settings surface's own port.
 *
 * SETTINGS_PORT is env-only, not settings.apiPort's sibling in config.json,
 * on purpose: the settings surface is what lets you edit config.json in the
 * first place, so its own port can't sensibly live inside the thing it
 * edits — and, more importantly, keeping it out of the live-editable/
 * unauthenticated settings API means the port the settings page itself
 * listens on can't be changed by a request to that same unauthenticated
 * surface. See AGENTS.md's "Two ports, by design" section.
 *
 * Everything else (apiKey/cliTimeoutMs/cliWorkdir/logCaptureContent/
 * logFilePath/apiPort) lives in config.json's `settings`, editable from
 * /settings — see types/config.ts.
 */
export interface Env {
  configPath: string;
  /** If set, overrides config.settings.apiPort for this run (the API port only — never the settings port). */
  apiPortOverride?: number;
  /** Port the settings surface (/settings, /api/settings/*) listens on. Env-only — see this file's top comment. Default 8868. */
  settingsPort: number;
}

const DEFAULT_SETTINGS_PORT = 8868;

export function loadEnv(): Env {
  const configPath = path.resolve(process.cwd(), process.env.CONFIG_PATH ?? "./config.json");
  const apiPortOverride = process.env.PORT?.trim() ? Number(process.env.PORT) : undefined;
  const settingsPort = process.env.SETTINGS_PORT?.trim() ? Number(process.env.SETTINGS_PORT) : DEFAULT_SETTINGS_PORT;
  return { configPath, apiPortOverride, settingsPort };
}
