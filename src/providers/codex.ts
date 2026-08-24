import { spawnManaged, timeoutErrorFor } from "../process/run.js";
import { CliExecutionError } from "../errors.js";
import type { CliProvider, RunOptions, RunResult, StreamChunk, Usage } from "./types.js";

const CMD = "codex";

function buildPrompt(opts: RunOptions): string {
  // codex has no system-prompt flag, so prepend a labeled block instead.
  const parts: string[] = [];
  if (opts.systemPrompt.trim() !== "") {
    parts.push(`System: ${opts.systemPrompt}`);
  }
  parts.push(opts.transcript);
  parts.push("Assistant:");
  return parts.join("\n\n");
}

function args(opts: RunOptions): string[] {
  const argv = [
    "exec",
    buildPrompt(opts),
    "--json",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "-m",
    opts.cliModel,
    "-C",
    opts.workdir,
  ];
  if (opts.extraFlags) {
    argv.push(...opts.extraFlags);
  }
  return argv;
}

function usageFrom(raw: { input_tokens?: number; output_tokens?: number } | undefined): Usage {
  const promptTokens = raw?.input_tokens ?? 0;
  const completionTokens = raw?.output_tokens ?? 0;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

/**
 * Shared JSONL consumption loop. codex uses the identical argv for streaming
 * and non-streaming (no per-mode flag exists) — only how the caller consumes
 * agent_message events differs, so both entry points funnel through this.
 */
async function* consume(opts: RunOptions): AsyncIterable<
  | { type: "message"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "warning"; message: string }
> {
  const managed = spawnManaged(CMD, args(opts), { cwd: opts.workdir, timeoutMs: opts.timeoutMs, signal: opts.signal });

  for await (const line of managed.stdout) {
    if (!line.trim()) continue;
    let evt: any;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }

    if (evt.type === "item.completed" && evt.item?.type === "agent_message") {
      yield { type: "message", text: evt.item.text ?? "" };
    } else if (evt.type === "item.completed" && evt.item?.type === "error") {
      // Transient warnings (e.g. websocket->HTTPS transport fallback) can
      // appear even on a fully successful run — never treat as fatal alone.
      yield { type: "warning", message: evt.item.message ?? "unknown codex warning" };
    } else if (evt.type === "turn.completed") {
      yield { type: "usage", usage: usageFrom(evt.usage) };
    }
    // thread.started, turn.started: ignore.
  }

  const { code } = await managed.whenExited;
  if (managed.didTimeout()) {
    throw timeoutErrorFor(CMD, opts.timeoutMs);
  }
  if (code !== 0) {
    // Surfaced by callers only if no agent_message was ever seen — a non-zero
    // exit code alone (or non-empty stderr) is not treated as failure when a
    // message did arrive, matching verified codex behavior.
    throw new CliExecutionError(`codex exited with code ${code}: ${managed.stderrTail() || "(no stderr output)"}`);
  }
}

export const codexProvider: CliProvider = {
  async runNonStreaming(opts: RunOptions): Promise<RunResult> {
    let text: string | undefined;
    let usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let lastWarning: string | undefined;
    let exitError: unknown;

    try {
      for await (const evt of consume(opts)) {
        if (evt.type === "message") text = evt.text;
        else if (evt.type === "usage") usage = evt.usage;
        else if (evt.type === "warning") lastWarning = evt.message;
      }
    } catch (err) {
      exitError = err;
    }

    if (text !== undefined) {
      return { text, usage, stopReason: "stop" };
    }
    if (exitError) throw exitError;
    throw new CliExecutionError(lastWarning ?? "codex produced no output");
  },

  async *runStreaming(opts: RunOptions): AsyncIterable<StreamChunk> {
    let sawMessage = false;
    let usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let lastWarning: string | undefined;
    let roleSent = false;

    try {
      for await (const evt of consume(opts)) {
        if (evt.type === "message") {
          if (!roleSent) {
            roleSent = true;
            yield { kind: "role" };
          }
          sawMessage = true;
          // No token-level deltas from codex — emit the whole message as one chunk.
          yield { kind: "delta", text: evt.text };
        } else if (evt.type === "usage") {
          usage = evt.usage;
        } else if (evt.type === "warning") {
          lastWarning = evt.message;
        }
      }
    } catch (err) {
      yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
      return;
    }

    if (sawMessage) {
      yield { kind: "done", usage, stopReason: "stop" };
    } else {
      yield { kind: "error", message: lastWarning ?? "codex produced no output" };
    }
  },
};
