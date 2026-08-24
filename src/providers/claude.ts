import { spawnManaged, timeoutErrorFor } from "../process/run.js";
import { CliExecutionError, CliParseError } from "../errors.js";
import type { CliProvider, RunOptions, RunResult, StopReason, StreamChunk, Usage } from "./types.js";

const CMD = "claude";

function baseArgs(opts: RunOptions, outputFormat: "json" | "stream-json"): string[] {
  const args = [
    "-p",
    opts.transcript,
    "--output-format",
    outputFormat,
    "--tools",
    "",
    "--permission-mode",
    "default",
    "--model",
    opts.cliModel,
    "--no-session-persistence",
    "--strict-mcp-config",
    "--setting-sources",
    "",
  ];
  if (outputFormat === "stream-json") {
    args.push("--include-partial-messages", "--verbose");
  }
  if (opts.systemPrompt.trim() !== "") {
    args.push("--system-prompt", opts.systemPrompt);
  }
  if (opts.extraFlags) {
    args.push(...opts.extraFlags);
  }
  return args;
}

function mapStopReason(stopReason: string | null, isError: boolean): StopReason {
  if (isError) return "error";
  if (stopReason === "max_tokens") return "length";
  return "stop";
}

function usageFrom(raw: { input_tokens?: number; output_tokens?: number } | undefined): Usage {
  const promptTokens = raw?.input_tokens ?? 0;
  const completionTokens = raw?.output_tokens ?? 0;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

export const claudeProvider: CliProvider = {
  async runNonStreaming(opts: RunOptions): Promise<RunResult> {
    const args = baseArgs(opts, "json");
    const managed = spawnManaged(CMD, args, { cwd: opts.workdir, timeoutMs: opts.timeoutMs, signal: opts.signal });

    let stdout = "";
    managed.stdout.on("line", (line) => {
      stdout += line;
    });

    const { code } = await managed.whenExited;
    if (managed.didTimeout()) {
      throw timeoutErrorFor(CMD, opts.timeoutMs);
    }
    if (code !== 0 && stdout.trim() === "") {
      throw new CliExecutionError(
        `claude exited with code ${code}: ${managed.stderrTail() || "(no stderr output)"}`
      );
    }

    let parsed: {
      result: string;
      is_error: boolean;
      stop_reason: string | null;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new CliParseError(`Failed to parse claude JSON output: ${stdout.slice(0, 500)}`);
    }

    if (parsed.is_error) {
      throw new CliExecutionError(parsed.result || "claude reported an error");
    }

    return {
      text: parsed.result,
      usage: usageFrom(parsed.usage),
      stopReason: mapStopReason(parsed.stop_reason, false),
    };
  },

  async *runStreaming(opts: RunOptions): AsyncIterable<StreamChunk> {
    const args = baseArgs(opts, "stream-json");
    const managed = spawnManaged(CMD, args, { cwd: opts.workdir, timeoutMs: opts.timeoutMs, signal: opts.signal });

    let roleSent = false;
    let sawResult = false;

    for await (const line of managed.stdout) {
      if (!line.trim()) continue;
      let evt: any;
      try {
        evt = JSON.parse(line);
      } catch {
        continue; // ignore unparseable lines rather than aborting an otherwise-good stream
      }

      if (evt.type === "stream_event") {
        const inner = evt.event;
        if (inner?.type === "message_start" && !roleSent) {
          roleSent = true;
          yield { kind: "role" };
        } else if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta") {
          if (!roleSent) {
            roleSent = true;
            yield { kind: "role" };
          }
          yield { kind: "delta", text: inner.delta.text };
        }
        // content_block_start/stop, message_delta, message_stop: no content, ignore.
      } else if (evt.type === "result") {
        sawResult = true;
        if (evt.is_error) {
          yield { kind: "error", message: evt.result || "claude reported an error" };
        } else {
          yield {
            kind: "done",
            usage: usageFrom(evt.usage),
            stopReason: mapStopReason(evt.stop_reason, false),
          };
        }
      }
      // "system", "assistant" (full snapshot, would duplicate deltas), "rate_limit_event": ignore.
    }

    const { code } = await managed.whenExited;
    if (managed.didTimeout()) {
      yield { kind: "error", message: `claude did not respond within ${opts.timeoutMs}ms and was killed` };
      return;
    }
    if (!sawResult) {
      yield {
        kind: "error",
        message: `claude exited (code ${code}) without producing a result: ${managed.stderrTail() || "(no stderr output)"}`,
      };
    }
  },
};
