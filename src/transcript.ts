import { resolveFilePart, resolveImageUrl, type Attachment } from "./attachments.js";
import { ValidationError } from "./errors.js";

/** The subset of OpenAI's content-part shapes accepted here — see attachments.ts. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } }
  | { type: "file"; file: { file_data?: string; filename?: string; file_id?: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** A plain string, or OpenAI's multimodal array-of-parts shape. `null` is legal on assistant messages. */
  content: string | ContentPart[] | null;
}

/** The transcript in order, split wherever a binary attachment sits. Providers that can interleave (claude, codex app-server) consume this directly. */
export type PromptSegment = { type: "text"; text: string } | { type: "attachment"; attachment: Attachment };

export interface FlattenedPrompt {
  systemPrompt: string;
  /**
   * Text-only rendering: every attachment appears as a `[Image 1: name]`-style
   * label at its position, never its bytes. Safe to log, and exactly what a
   * text-only provider path (codex exec, which takes images out-of-band via
   * `--image`) sends as the prompt.
   */
  transcript: string;
  /** Same content as `transcript`, with each attachment's bytes right after its label. */
  segments: PromptSegment[];
  attachments: Attachment[];
}

export interface FlattenOptions {
  /** WrapperSettings.localFileRoots — see attachments.ts. */
  localFileRoots: string[];
}

/**
 * OpenAI chat completions are stateless (full history resent each call) and
 * neither CLI accepts a structured message array, so we flatten the
 * conversation into a system-prompt string plus a `User:`/`Assistant:`
 * transcript that gets passed as a single prompt. Images/PDFs are only
 * accepted on user messages; text files are inlined wherever they appear
 * (also user messages only).
 */
export function flattenMessages(messages: ChatMessage[], opts: FlattenOptions): FlattenedPrompt {
  const systemParts: string[] = [];
  const segments: PromptSegment[] = [];
  const attachments: Attachment[] = [];
  let first = true;

  const pushText = (text: string) => {
    const last = segments[segments.length - 1];
    if (last?.type === "text") last.text += text;
    else segments.push({ type: "text", text });
  };

  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(textOnly(msg));
      continue;
    }
    let prefix: string;
    if (msg.role === "user") {
      prefix = "User: ";
    } else if (msg.role === "assistant") {
      prefix = "Assistant: ";
    } else {
      // Tools are disabled end-to-end, so a tool-role message should never
      // legitimately appear. Fold it in defensively rather than erroring the
      // whole request on a slightly non-conformant client.
      console.warn(`Unexpected "tool" role message received; folding into transcript as user content.`);
      prefix = "User: [tool result]: ";
    }
    pushText((first ? "" : "\n\n") + prefix);
    first = false;

    if (msg.role !== "user" || !Array.isArray(msg.content)) {
      pushText(textOnly(msg));
      continue;
    }

    msg.content.forEach((part, i) => {
      const sep = i === 0 ? "" : "\n";
      if (part?.type === "text") {
        pushText(sep + (typeof part.text === "string" ? part.text : ""));
        return;
      }
      const index = attachments.length + 1;
      let resolved;
      if (part?.type === "image_url") {
        resolved = resolveImageUrl(part.image_url?.url, index, opts.localFileRoots);
      } else if (part?.type === "file") {
        resolved = resolveFilePart(part.file, index, opts.localFileRoots);
      } else {
        throw new ValidationError(`Unsupported content part type: ${JSON.stringify((part as { type?: unknown })?.type)}`);
      }
      if (resolved.kind === "text") {
        pushText(`${sep}[File: ${resolved.filename}]\n${resolved.text}\n[End of file: ${resolved.filename}]`);
        return;
      }
      attachments.push(resolved);
      pushText(`${sep}[${resolved.kind === "image" ? "Image" : "PDF"} ${attachments.length}: ${resolved.filename}]`);
      segments.push({ type: "attachment", attachment: resolved });
    });
  }

  return {
    systemPrompt: systemParts.join("\n\n"),
    transcript: segments.map((s) => (s.type === "text" ? s.text : "")).join(""),
    segments,
    attachments,
  };
}

/** system/assistant/tool content: a string, null, or an array of text parts only. */
function textOnly(msg: ChatMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (msg.content == null) return "";
  if (!Array.isArray(msg.content)) throw new ValidationError(`\`content\` of a ${msg.role} message must be a string or an array of content parts`);
  return msg.content
    .map((part) => {
      if (part?.type !== "text") {
        throw new ValidationError(`Only text content parts are supported on ${msg.role} messages; images and files must go in user messages`);
      }
      return typeof part.text === "string" ? part.text : "";
    })
    .join("\n");
}
