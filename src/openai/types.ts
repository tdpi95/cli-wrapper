import type { ChatMessage } from "../transcript.js";

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
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
      message: { role: "assistant"; content: string };
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
      delta: { role?: "assistant"; content?: string };
      finish_reason: "stop" | "length" | "error" | null;
    },
  ];
}
