import type { Attachment, AttachmentKind } from "../attachments.js";
import type { PromptSegment } from "../transcript.js";
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
  /** See ModelMapping.enableWebSearch — each provider wires this to its own mechanism. */
  enableWebSearch?: boolean;
  systemPrompt: string;
  /** Text-only rendering, attachments shown as labels — see FlattenedPrompt in transcript.ts. */
  transcript: string;
  /** `transcript` with each attachment's bytes after its label, in order. A text-only request is one text segment. */
  segments: PromptSegment[];
  /** Every attachment in `segments`, in order. chat.ts has already rejected any kind outside the provider's supportedAttachmentKinds. */
  attachments: Attachment[];
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
  /** Attachment kinds this CLI can take natively; chat.ts rejects anything else with a 400 before spawning. */
  supportedAttachmentKinds: ReadonlySet<AttachmentKind>;
  runNonStreaming(opts: RunOptions): Promise<RunResult>;
  runStreaming(opts: RunOptions): AsyncIterable<StreamChunk>;
}
