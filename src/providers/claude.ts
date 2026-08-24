import { runWarmNonStreaming, runWarmStreaming } from "../process/claudePool.js";
import type { CliProvider } from "./types.js";

// The actual process management (warm pool, /clear-before-every-request,
// retire-after-20-30-uses) lives in process/claudePool.ts — see that file's
// top-of-file comment for the full design rationale. This file just adapts
// it to the CliProvider shape chat.ts expects, same as codex.ts.
export const claudeProvider: CliProvider = {
  runNonStreaming: runWarmNonStreaming,
  runStreaming: runWarmStreaming,
};
