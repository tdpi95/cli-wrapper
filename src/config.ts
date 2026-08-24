import fs from "node:fs";
import path from "node:path";
import type { ModelMapping, WrapperConfig } from "./types/config.js";
import { ValidationError, NotFoundError } from "./errors.js";

let configPath: string;

/** Must be called once at startup before load/save are used. */
export function initConfig(resolvedConfigPath: string, examplePath: string): void {
  configPath = resolvedConfigPath;
  if (!fs.existsSync(configPath)) {
    fs.copyFileSync(examplePath, configPath);
  }
}

/** Reads config.json fresh from disk every call — cheap, small file, keeps edits live without restart. */
export function loadConfig(): WrapperConfig {
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as WrapperConfig;
  if (!parsed || !Array.isArray(parsed.models)) {
    throw new Error(`Malformed config at ${configPath}: expected { version, models: [] }`);
  }
  return parsed;
}

/** Atomic write: write to a temp file then rename over the target. */
export function saveConfig(cfg: WrapperConfig): void {
  const tmpPath = `${configPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  fs.renameSync(tmpPath, configPath);
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
