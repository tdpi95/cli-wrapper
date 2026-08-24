import type { ProviderName } from "../types/config.js";
import type { CliProvider } from "./types.js";
import { claudeProvider } from "./claude.js";
import { codexProvider } from "./codex.js";

export function getProvider(name: ProviderName): CliProvider {
  if (name === "claude") return claudeProvider;
  if (name === "codex") return codexProvider;
  throw new Error(`Unknown provider: ${name}`);
}

export type { CliProvider, RunOptions, RunResult, StreamChunk, Usage, StopReason } from "./types.js";
