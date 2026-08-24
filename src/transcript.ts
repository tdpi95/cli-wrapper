export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface FlattenedPrompt {
  systemPrompt: string;
  transcript: string;
}

/**
 * OpenAI chat completions are stateless (full history resent each call) and
 * neither CLI accepts a structured message array, so we flatten the
 * conversation into a system-prompt string plus a `User:`/`Assistant:`
 * transcript that gets passed as a single prompt argument.
 */
export function flattenMessages(messages: ChatMessage[]): FlattenedPrompt {
  const systemParts: string[] = [];
  const turns: string[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
    } else if (msg.role === "user") {
      turns.push(`User: ${msg.content}`);
    } else if (msg.role === "assistant") {
      turns.push(`Assistant: ${msg.content}`);
    } else {
      // Tools are disabled end-to-end, so a tool-role message should never
      // legitimately appear. Fold it in defensively rather than erroring the
      // whole request on a slightly non-conformant client.
      console.warn(`Unexpected "tool" role message received; folding into transcript as user content.`);
      turns.push(`User: [tool result]: ${msg.content}`);
    }
  }

  return {
    systemPrompt: systemParts.join("\n\n"),
    transcript: turns.join("\n\n"),
  };
}
