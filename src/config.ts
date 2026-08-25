import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SETTINGS, REASONING_EFFORT_VALUES, type ModelMapping, type ReasoningEffort, type WrapperConfig, type WrapperSettings } from "./types/config.js";
import { ValidationError, NotFoundError } from "./errors.js";

let configPath: string;

function generateApiKey(): string {
  return crypto.randomBytes(24).toString("hex");
}

/**
 * One-time convenience for machines upgrading from a pre-settings-page
 * config.json (version 1, no `settings` block): fall back to the old env
 * vars if they're still set in this process's environment, so an existing
 * deployment doesn't silently lose its configured token/timeout/etc. on
 * upgrade. Never consulted again after this migration writes them into
 * config.json.
 */
function settingsFromLegacyEnv(): Partial<WrapperSettings> {
  const out: Partial<WrapperSettings> = {};
  if (process.env.WRAPPER_API_KEY?.trim()) out.apiKey = process.env.WRAPPER_API_KEY.trim();
  if (process.env.PORT?.trim()) out.apiPort = Number(process.env.PORT);
  if (process.env.CLI_TIMEOUT_MS?.trim()) out.cliTimeoutMs = Number(process.env.CLI_TIMEOUT_MS);
  if (process.env.CLI_WORKDIR?.trim()) out.cliWorkdir = process.env.CLI_WORKDIR.trim();
  if (process.env.LOG_CAPTURE_CONTENT?.trim()) {
    out.logCaptureContent = !["false", "0", "no", "off"].includes(process.env.LOG_CAPTURE_CONTENT.trim().toLowerCase());
  }
  if (process.env.LOG_FILE_PATH?.trim()) out.logFilePath = process.env.LOG_FILE_PATH.trim();
  return out;
}

/**
 * Must be called once at startup before load/save are used. Seeds
 * config.json from config.example.json on first run, and migrates an
 * existing pre-settings config (version 1) in place by adding a `settings`
 * block. Either way, ensures `settings.apiKey` is non-empty by generating a
 * random one — auth is on by default; going open requires an explicit,
 * visible edit on the settings page afterward, not silence at startup.
 */
export function initConfig(resolvedConfigPath: string, examplePath: string): void {
  configPath = resolvedConfigPath;

  if (!fs.existsSync(configPath)) {
    const seed = fs.existsSync(examplePath) ? (JSON.parse(fs.readFileSync(examplePath, "utf8")) as Partial<WrapperConfig>) : {};
    const legacy = settingsFromLegacyEnv();
    const settings: WrapperSettings = { ...DEFAULT_SETTINGS, ...seed.settings, ...legacy };
    const apiKeySource = legacy.apiKey ? "legacy-env" : !settings.apiKey.trim() ? "generated" : "seed";
    if (!settings.apiKey.trim()) settings.apiKey = generateApiKey();
    const config: WrapperConfig = { version: 2, settings, models: seed.models ?? [] };
    saveConfig(config);
    announceApiKey(settings.apiKey, apiKeySource);
    return;
  }

  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<WrapperConfig> & { settings?: Partial<WrapperSettings> };
  if (!Array.isArray(raw.models)) {
    throw new Error(`Malformed config at ${configPath}: expected { version, settings, models: [] }`);
  }

  let changed = false;
  let settings: WrapperSettings;
  let apiKeySource: "legacy-env" | "generated" | "unchanged" = "unchanged";
  if (!raw.settings) {
    // Migrating a pre-settings-page (version 1) config: there's no prior
    // explicit apiKey choice on disk to respect here at all, so this is the
    // one case (besides first-run, above) where generating a fresh key is
    // correct rather than clobbering something the operator set.
    const legacy = settingsFromLegacyEnv();
    settings = { ...DEFAULT_SETTINGS, ...legacy };
    if (legacy.apiKey) {
      apiKeySource = "legacy-env";
    } else if (!settings.apiKey.trim()) {
      settings.apiKey = generateApiKey();
      apiKeySource = "generated";
    }
    changed = true;
  } else {
    // A `settings` block already exists on disk — respect its apiKey
    // verbatim, including an explicit "" (auth intentionally disabled on
    // /v1/*, chosen on the settings page). Never regenerate here: doing so
    // unconditionally on every startup was a real bug — it silently
    // re-enabled auth with a fresh random key on every restart after an
    // operator deliberately blanked it, contradicting the documented
    // invariant that a blank apiKey only ever happens via an explicit,
    // visible edit (see "Settings has no auth, by design" in AGENTS.md).
    settings = { ...DEFAULT_SETTINGS, ...raw.settings };
  }

  // Migrating a pre-port-split config: it has a single `port` field (used
  // for everything) instead of `apiPort` (API only — the settings surface
  // now listens on its own env-only SETTINGS_PORT, default 8868; see
  // AGENTS.md's "Two ports, by design"). Deliberately NOT carrying the old
  // `port` value straight over to `apiPort` — for the common case where it
  // was still sitting at the old shared default (8868), that would collide
  // with the new default SETTINGS_PORT on this same host. Reset to the new
  // default instead; the stale `port` key is dropped either way.
  const legacySettings = raw.settings as (Partial<WrapperSettings> & { port?: number }) | undefined;
  if (legacySettings && !("apiPort" in legacySettings)) {
    settings.apiPort = DEFAULT_SETTINGS.apiPort;
    changed = true;
  }
  delete (settings as WrapperSettings & { port?: number }).port;

  const config: WrapperConfig = { version: 2, settings, models: raw.models };
  if (changed) {
    saveConfig(config);
    announceApiKey(settings.apiKey, apiKeySource);
  }
}

function announceApiKey(apiKey: string, source: "legacy-env" | "generated" | "seed" | "unchanged"): void {
  if (source === "unchanged" || source === "seed") return;
  console.log("");
  if (source === "legacy-env") {
    console.log(`  Migrated your existing WRAPPER_API_KEY env var into config.json: ${apiKey}`);
    console.log("  It's no longer read from the environment — the env var can be removed.");
  } else {
    console.log(`  Generated a new API key for /v1/*: ${apiKey}`);
  }
  console.log("  View or change it any time at /settings (no login required to open that page).");
  console.log("");
}

/** Reads config.json fresh from disk every call — cheap, small file, keeps edits live without restart. */
export function loadConfig(): WrapperConfig {
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as WrapperConfig;
  if (!parsed || !Array.isArray(parsed.models) || !parsed.settings) {
    throw new Error(`Malformed config at ${configPath}: expected { version, settings, models: [] }`);
  }
  return parsed;
}

/** Atomic write: write to a temp file then rename over the target. */
export function saveConfig(cfg: WrapperConfig): void {
  const tmpPath = `${configPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  fs.renameSync(tmpPath, configPath);
}

export function getSettings(): WrapperSettings {
  return loadConfig().settings;
}

function validateSettings(s: WrapperSettings): void {
  if (typeof s.apiKey !== "string") {
    throw new ValidationError("`apiKey` must be a string (empty string disables auth on /v1/*)");
  }
  if (!Number.isInteger(s.apiPort) || s.apiPort < 1 || s.apiPort > 65535) {
    throw new ValidationError("`apiPort` must be an integer between 1 and 65535");
  }
  if (!Number.isInteger(s.cliTimeoutMs) || s.cliTimeoutMs < 1000) {
    throw new ValidationError("`cliTimeoutMs` must be an integer >= 1000");
  }
  if (typeof s.cliWorkdir !== "string" || s.cliWorkdir.trim() === "") {
    throw new ValidationError("`cliWorkdir` must be a non-empty string");
  }
  if (typeof s.logCaptureContent !== "boolean") {
    throw new ValidationError("`logCaptureContent` must be a boolean");
  }
  if (s.logFilePath !== null && (typeof s.logFilePath !== "string" || s.logFilePath.trim() === "")) {
    throw new ValidationError("`logFilePath` must be a non-empty string or null");
  }
}

/** Merges `patch` onto the current settings, validates, and saves. Returns the new settings. */
export function updateSettings(patch: Partial<WrapperSettings>): WrapperSettings {
  const cfg = loadConfig();
  const next: WrapperSettings = { ...cfg.settings, ...patch };
  validateSettings(next);
  cfg.settings = next;
  saveConfig(cfg);
  return next;
}

export function getMapping(id: string): ModelMapping | undefined {
  return loadConfig().models.find((m) => m.id === id);
}

function validateMapping(m: Partial<ModelMapping>): asserts m is ModelMapping {
  if (!m.id || typeof m.id !== "string" || m.id.trim() === "") {
    throw new ValidationError("`id` is required and must be a non-empty string");
  }
  if (m.provider !== "claude" && m.provider !== "codex") {
    throw new ValidationError('`provider` must be "claude" or "codex"');
  }
  if (!m.cliModel || typeof m.cliModel !== "string" || m.cliModel.trim() === "") {
    throw new ValidationError("`cliModel` is required and must be a non-empty string");
  }
  if (m.extraFlags !== undefined && !Array.isArray(m.extraFlags)) {
    throw new ValidationError("`extraFlags` must be an array of strings if provided");
  }
  if (m.reasoningEffort !== undefined && !REASONING_EFFORT_VALUES.includes(m.reasoningEffort as ReasoningEffort)) {
    throw new ValidationError(`\`reasoningEffort\` must be one of: ${REASONING_EFFORT_VALUES.join(", ")}`);
  }
  if (m.allowReasoningEffortOverride !== undefined && typeof m.allowReasoningEffortOverride !== "boolean") {
    throw new ValidationError("`allowReasoningEffortOverride` must be a boolean");
  }
  if (m.enableWebSearch !== undefined && typeof m.enableWebSearch !== "boolean") {
    throw new ValidationError("`enableWebSearch` must be a boolean");
  }
}

export function addMapping(input: Partial<ModelMapping>): ModelMapping {
  validateMapping(input);
  const cfg = loadConfig();
  if (cfg.models.some((m) => m.id === input.id)) {
    throw new ValidationError(`A model mapping with id "${input.id}" already exists`);
  }
  cfg.models.push(input);
  saveConfig(cfg);
  return input;
}

export function updateMapping(id: string, input: Partial<ModelMapping>): ModelMapping {
  const merged: Partial<ModelMapping> = { ...input, id: input.id ?? id };
  validateMapping(merged);
  const cfg = loadConfig();
  const idx = cfg.models.findIndex((m) => m.id === id);
  if (idx === -1) {
    throw new NotFoundError(`No model mapping with id "${id}"`);
  }
  if (merged.id !== id && cfg.models.some((m) => m.id === merged.id)) {
    throw new ValidationError(`A model mapping with id "${merged.id}" already exists`);
  }
  cfg.models[idx] = merged;
  saveConfig(cfg);
  return merged;
}

export function deleteMapping(id: string): void {
  const cfg = loadConfig();
  const idx = cfg.models.findIndex((m) => m.id === id);
  if (idx === -1) {
    throw new NotFoundError(`No model mapping with id "${id}"`);
  }
  cfg.models.splice(idx, 1);
  saveConfig(cfg);
}

export function resolveConfigExamplePath(): string {
  // src/config.ts -> dist/config.js at runtime; example file lives at project root either way.
  return path.resolve(import.meta.dirname, "..", "config.example.json");
}
