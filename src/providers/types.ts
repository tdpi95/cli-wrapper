export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type StopReason = "stop" | "length" | "error";

export interface RunOptions {
  cliModel: string;
  extraFlags?: string[];
  systemPrompt: string;
  transcript: string;
  timeoutMs: number;
  workdir: string;
  signal?: AbortSignal;
}

export interface RunResult {
  text: string;
  usage: Usage;
  stopReason: StopReason;
}

export type StreamChunk =
  | { kind: "role" }
  | { kind: "delta"; text: string }
  | { kind: "done"; usage: Usage; stopReason: StopReason }
  | { kind: "error"; message: string };

export interface CliProvider {
  runNonStreaming(opts: RunOptions): Promise<RunResult>;
  runStreaming(opts: RunOptions): AsyncIterable<StreamChunk>;
}
