import type { ReasoningEffort } from "../types/config.js";

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type StopReason = "stop" | "length" | "error";

export interface RunOptions {
  cliModel: string;
  extraFlags?: string[];
  /** claude: --effort. codex: -c model_reasoning_effort=. Omitted = no flag, today's default behavior. */
  reasoningEffort?: ReasoningEffort;
  systemPrompt: string;
  transcript: string;
  timeoutMs: number;
  workdir: string;
  signal?: AbortSignal;
}

export interface RunResult {
  text: string;
  /**
   * Accumulated reasoning/thinking content, if the CLI produced any (only
   * possible when reasoningEffort was set — see RunOptions). Undefined, not
   * "", when none was captured, so callers can tell "no reasoning" apart
   * from "reasoning happened but came back empty" (claude can redact
   * thinking text while still billing the tokens — see claudePool.ts).
   */
  reasoningText?: string;
  usage: Usage;
  stopReason: StopReason;
}

export type StreamChunk =
  | { kind: "role" }
  | { kind: "reasoning"; text: string }
  | { kind: "delta"; text: string }
  | { kind: "done"; usage: Usage; stopReason: StopReason }
  | { kind: "error"; message: string };

export interface CliProvider {
  runNonStreaming(opts: RunOptions): Promise<RunResult>;
  runStreaming(opts: RunOptions): AsyncIterable<StreamChunk>;
}
