import type { ChatMessage } from "../transcript.js";

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  // OpenAI's own chat.completions field name for reasoning models. Only
  // honored if the resolved model mapping has `allowReasoningEffortOverride:
  // true` (see routes/chat.ts) — otherwise ignored like any other
  // unsupported field below, not an error.
  reasoning_effort?: string;
  // Other OpenAI fields (temperature, top_p, max_tokens, etc.) are accepted
  // by Express's JSON body parser but intentionally ignored — unsupported
  // passthroughs, not silently misapplied.
  [key: string]: unknown;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: [
    {
      index: 0;
      // reasoning_content: the de facto OpenAI-compatible convention for a
      // model's reasoning/thinking trace (DeepSeek, LiteLLM, Open WebUI,
      // etc. all read this field name) — not an official OpenAI field,
      // since chat.completions has no standard one. Present only when the
      // provider actually captured some (see RunResult.reasoningText).
      message: { role: "assistant"; content: string; reasoning_content?: string };
      finish_reason: "stop" | "length" | "error";
    },
  ];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: [
    {
      index: 0;
      delta: { role?: "assistant"; content?: string; reasoning_content?: string };
      finish_reason: "stop" | "length" | "error" | null;
    },
  ];
}
