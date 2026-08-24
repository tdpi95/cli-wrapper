import path from "node:path";
import { Router } from "express";
import { getMapping, getSettings } from "../config.js";
import { getProvider } from "../providers/index.js";
import { flattenMessages, type ChatMessage } from "../transcript.js";
import { newCompletionId, toChatCompletion, toSSELine, DONE_LINE } from "../openai/transform.js";
import { ModelNotFoundError, TimeoutError, ValidationError, toApiError } from "../errors.js";
import type { ChatCompletionRequest } from "../openai/types.js";
import { addLogEntry } from "../logs.js";
import type { Usage } from "../providers/types.js";
import { REASONING_EFFORT_VALUES, type ReasoningEffort } from "../types/config.js";

// Auth is applied at the app-assembly level (see app.ts), scoped by URL path
// prefix — not here — since a router-internal `.use(auth)` with no path
// would match every request reaching this router's mount point, not just
// the routes this file defines.
export function chatRouter(): Router {
  const router = Router();

  router.post("/v1/chat/completions", async (req, res) => {
    const body = req.body as Partial<ChatCompletionRequest>;
    const startedAt = Date.now();
    // Read fresh per request — same "config.json is the source of truth,
    // re-read every call, no caching" convention as config.ts, now covering
    // cliTimeoutMs/cliWorkdir/logCaptureContent too since they're editable
    // from /settings at runtime.
    const settings = getSettings();
    const modelForLog = typeof body.model === "string" && body.model.trim() !== "" ? body.model : "(missing)";
    let providerForLog: "claude" | "codex" | "unknown" = "unknown";
    const streamForLog = body.stream === true;
    const captureContent = settings.logCaptureContent;
    let inputForLog: string | undefined;

    try {
      if (typeof body.model !== "string" || body.model.trim() === "") {
        throw new ValidationError("`model` is required and must be a string");
      }
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        throw new ValidationError("`messages` is required and must be a non-empty array");
      }

      const mapping = getMapping(body.model);
      if (!mapping) {
        throw new ModelNotFoundError(body.model);
      }
      providerForLog = mapping.provider;

      // The mapping's own default effort, optionally overridden by the
      // request — but only if the mapping opted into that. If it didn't,
      // an incoming `reasoning_effort` is silently ignored, same as any
      // other unsupported OpenAI field (temperature, top_p, etc.) rather
      // than erroring — it's not a typo'd required field, just a request
      // for a capability this mapping hasn't turned on.
      let reasoningEffort: ReasoningEffort | undefined = mapping.reasoningEffort;
      if (mapping.allowReasoningEffortOverride && typeof body.reasoning_effort === "string" && body.reasoning_effort.trim() !== "") {
        const requested = body.reasoning_effort.trim();
        if (!REASONING_EFFORT_VALUES.includes(requested as ReasoningEffort)) {
          throw new ValidationError(`\`reasoning_effort\` must be one of: ${REASONING_EFFORT_VALUES.join(", ")}`);
        }
        reasoningEffort = requested as ReasoningEffort;
      }

      const { systemPrompt, transcript } = flattenMessages(body.messages as ChatMessage[]);
      if (captureContent) {
        inputForLog = systemPrompt.trim() !== "" ? `System: ${systemPrompt}\n\n${transcript}` : transcript;
      }
      const provider = getProvider(mapping.provider);

      // Note: `req` (a Readable) emits 'close' as soon as its body has been
      // fully consumed by express.json() — that's unrelated to the client's
      // connection state and fires on every ordinary request. `res.on('close')`
      // is the correct signal: it only fires early (before writableEnded) if
      // the underlying connection actually drops before we finish responding.
      const controller = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });

      const runOpts = {
        cliModel: mapping.cliModel,
        extraFlags: mapping.extraFlags,
        reasoningEffort,
        systemPrompt,
        transcript,
        timeoutMs: settings.cliTimeoutMs,
        workdir: path.resolve(process.cwd(), settings.cliWorkdir),
        signal: controller.signal,
      };

      const id = newCompletionId();
      const created = Math.floor(Date.now() / 1000);

      if (body.stream === true) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();

        let lastUsage: Usage | undefined;
        let outputSoFar = "";
        for await (const streamChunk of provider.runStreaming(runOpts)) {
          if (streamChunk.kind === "error") {
            // Headers are already flushed for SSE by this point regardless of
            // whether any content chunk went out yet, so HTTP status can no
            // longer change — surface the failure as an error chunk instead.
            res.write(sseLine(streamChunk.message));
            addLogEntry({
              model: modelForLog,
              provider: providerForLog,
              stream: true,
              status: "error",
              durationMs: Date.now() - startedAt,
              error: streamChunk.message,
              input: inputForLog,
              output: captureContent ? outputSoFar || undefined : undefined, // whatever streamed before the error, if anything
            });
            res.write(DONE_LINE);
            res.end();
            return;
          }
          if (streamChunk.kind === "delta") outputSoFar += streamChunk.text;
          if (streamChunk.kind === "done") lastUsage = streamChunk.usage;
          const line = toSSELine(streamChunk, id, created, body.model);
          if (line) {
            res.write(line);
          }
        }
        res.write(DONE_LINE);
        res.end();
        addLogEntry({
          model: modelForLog,
          provider: providerForLog,
          stream: true,
          status: "success",
          durationMs: Date.now() - startedAt,
          usage: lastUsage,
          input: inputForLog,
          output: captureContent ? outputSoFar : undefined,
        });
        return;
      }

      const result = await provider.runNonStreaming(runOpts);
      res.json(toChatCompletion(result, body.model, id, created));
      addLogEntry({
        model: modelForLog,
        provider: providerForLog,
        stream: false,
        status: "success",
        durationMs: Date.now() - startedAt,
        usage: result.usage,
        input: inputForLog,
        output: captureContent ? result.text : undefined,
      });
    } catch (err) {
      const { status, body: errBody } = toApiError(err);
      addLogEntry({
        model: modelForLog,
        provider: providerForLog,
        stream: streamForLog,
        status: err instanceof TimeoutError ? "timeout" : "error",
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
        input: inputForLog,
      });
      if (!res.headersSent) {
        res.status(status).json(errBody);
      } else {
        // Streaming already started; HTTP status can't change at this point.
        console.error("Error mid-stream:", err);
        res.end();
      }
    }
  });

  return router;
}

function sseLine(errorMessage: string): string {
  return `data: ${JSON.stringify({ error: { message: errorMessage, type: "api_error", code: "provider_error" } })}\n\n`;
}
