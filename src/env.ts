import fs from "node:fs";
import path from "node:path";
import { CLI_WRAPPER_HOME_DIR } from "./types/config.js";

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

/**
 * A minimal, cheap check — not full schema validation (that's config.ts's
 * job, and it throws a proper error if this passes but the file turns out to
 * be malformed some other way). Just enough to tell "there's a config.json
 * here" from "there isn't" for the cwd-vs-home-dir default decision below:
 * readable, parses as JSON, and has the one field every version of this
 * file (including the pre-settings-page v1 shape initConfig() still
 * migrates) has always had.
 */
function looksLikeConfigFile(p: string): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as { models?: unknown };
    return Array.isArray(parsed?.models);
  } catch {
    return false;
  }
}

/**
 * No CONFIG_PATH override: default to ./config.json only if one actually
 * exists there and looks valid — otherwise fall back to
 * ~/.cli-wrapper/config.json, the same home-dir dotfolder cliWorkdir and a
 * relative logFilePath already default under (see types/config.ts's
 * CLI_WRAPPER_HOME_DIR doc comment). Without this, a globally-installed
 * `cli-wrapper` run from an arbitrary directory with no config.json of its
 * own would seed and scatter a brand-new one wherever it happened to be
 * invoked from — the same class of problem CLI_WRAPPER_HOME_DIR was
 * introduced to fix for cliWorkdir/logFilePath, just left unfixed here.
 * A directory that already has its own valid config.json (e.g. this repo's
 * own checkout during local dev) keeps using it, unchanged from before.
 */
function resolveDefaultConfigPath(): string {
  const cwdConfigPath = path.resolve(process.cwd(), "config.json");
  if (looksLikeConfigFile(cwdConfigPath)) return cwdConfigPath;
  return path.join(CLI_WRAPPER_HOME_DIR, "config.json");
}

export function loadEnv(): Env {
  const configPathOverride = process.env.CONFIG_PATH?.trim();
  const configPath = configPathOverride ? path.resolve(process.cwd(), configPathOverride) : resolveDefaultConfigPath();
  const apiPortOverride = process.env.PORT?.trim() ? Number(process.env.PORT) : undefined;
  const settingsPort = process.env.SETTINGS_PORT?.trim() ? Number(process.env.SETTINGS_PORT) : DEFAULT_SETTINGS_PORT;
  return { configPath, apiPortOverride, settingsPort };
}
