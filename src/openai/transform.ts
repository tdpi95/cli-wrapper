import crypto from "node:crypto";
import type { RunResult, StreamChunk } from "../providers/types.js";
import type { ChatCompletionChunk, ChatCompletionResponse } from "./types.js";

export function newCompletionId(): string {
  return `chatcmpl-${crypto.randomUUID()}`;
}

export function toChatCompletion(result: RunResult, model: string, id: string, created: number): ChatCompletionResponse {
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: result.text,
          ...(result.reasoningText ? { reasoning_content: result.reasoningText } : {}),
        },
        finish_reason: result.stopReason,
      },
    ],
    usage: {
      prompt_tokens: result.usage.promptTokens,
      completion_tokens: result.usage.completionTokens,
      total_tokens: result.usage.totalTokens,
    },
  };
}

function chunk(id: string, created: number, model: string, delta: ChatCompletionChunk["choices"][0]["delta"], finishReason: ChatCompletionChunk["choices"][0]["finish_reason"]): ChatCompletionChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function sseLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export const DONE_LINE = "data: [DONE]\n\n";

/**
 * Converts one provider StreamChunk into zero or more SSE lines. Returns
 * null for a StreamChunk that produces no output on its own (error is
 * handled by the caller, which decides whether to abort before headers are
 * sent or end the stream gracefully after).
 */
export function toSSELine(streamChunk: StreamChunk, id: string, created: number, model: string): string | null {
  switch (streamChunk.kind) {
    case "role":
      return sseLine(chunk(id, created, model, { role: "assistant" }, null));
    case "reasoning":
      return sseLine(chunk(id, created, model, { reasoning_content: streamChunk.text }, null));
    case "delta":
      return sseLine(chunk(id, created, model, { content: streamChunk.text }, null));
    case "done":
      return sseLine(chunk(id, created, model, {}, streamChunk.stopReason));
    case "error":
      return null;
  }
}
