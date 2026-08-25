import { spawnManaged, timeoutErrorFor } from "../process/run.js";
import { CliExecutionError } from "../errors.js";
import { getSettings } from "../config.js";
import type { CliProvider, RunOptions, RunResult, StreamChunk, Usage } from "./types.js";

const CMD = "codex";

// See AGENTS.md gotcha #5's "Fixing the slow start" addendum and
// WrapperSettings.codexBypassProxyForOpenAI's doc comment for the full
// investigation. Only these two host families are ever added — the ones
// verified to be codex's own WebSocket/HTTPS endpoints (chatgpt.com for
// ChatGPT-plan auth, openai.com for API-key auth, not re-verified here).
const PROXY_BYPASS_HOSTS = ["chatgpt.com", ".chatgpt.com", "openai.com", ".openai.com"];

/**
 * Builds an env override that widens NO_PROXY/no_proxy to also cover
 * codex's own hosts, merged onto (never replacing) whatever the operator's
 * environment already has there — an existing bypass list (internal hosts,
 * etc.) must survive. Read fresh per call, same "settings read live" convention
 * as everywhere else in this codebase, so flipping the setting on /settings
 * takes effect on the very next request with no restart.
 */
function proxyBypassEnv(): Record<string, string> | undefined {
  if (!getSettings().codexBypassProxyForOpenAI) return undefined;
  const merge = (existing: string | undefined): string => {
    const hosts = new Set(
      (existing ?? "")
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean)
    );
    for (const h of PROXY_BYPASS_HOSTS) hosts.add(h);
    return [...hosts].join(",");
  };
  // Both casings: some HTTP clients only check one or the other.
  return { NO_PROXY: merge(process.env.NO_PROXY), no_proxy: merge(process.env.no_proxy) };
}

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
    // Without this, codex auto-discovers and injects the nearest AGENTS.md
    // up the directory tree into its context (verified live: leaked this
    // very repo's own AGENTS.md content into responses when cliWorkdir sat
    // inside it) — not the chat-only "clean" backend this wrapper is meant
    // to provide. 0 disables reading it entirely.
    "-c",
    "project_doc_max_bytes=0",
    // model_reasoning_summary/show_raw_agent_reasoning gate whether codex
    // emits any "reasoning" item at all — verified live that any one or two
    // of these three overrides alone produces nothing, all three together
    // are required. Bundled with reasoningEffort (rather than always-on) so
    // a plain request that never asks for reasoning doesn't pay for the
    // extra reasoning-summary generation/latency by default.
    ...(opts.reasoningEffort
      ? ["-c", `model_reasoning_effort=${opts.reasoningEffort}`, "-c", "model_reasoning_summary=detailed", "-c", "show_raw_agent_reasoning=true"]
      : []),
    // Grants codex's built-in web_search tool (config.toml's [tools] block,
    // here as a one-off -c override). Unlike claude, there's no permission
    // gate to fight — codex exec never prompts (see gotcha #3) — so this is
    // just the one flag. Verified live: produces real item.completed events
    // of type "web_search" plus a final agent_message citing what it found;
    // consume()'s event loop already ignores item types it doesn't
    // pattern-match (see its trailing "ignore" comment), so no changes were
    // needed there to support this. Whether the account/model actually
    // supports it isn't re-validated here — same laissez-faire approach as
    // cliModel (gotcha #4).
    ...(opts.enableWebSearch ? ["-c", "tools.web_search=true"] : []),
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
  | { type: "reasoning"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "warning"; message: string }
> {
  const managed = spawnManaged(CMD, args(opts), {
    cwd: opts.workdir,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    env: proxyBypassEnv(),
  });

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
    } else if (evt.type === "item.completed" && evt.item?.type === "reasoning") {
      // A short summary, not raw chain-of-thought (codex/GPT-5 don't expose
      // that) — one item per reasoning "chunk" the model produces during the
      // turn, so a turn can yield several of these before its agent_message.
      yield { type: "reasoning", text: evt.item.text ?? "" };
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
    const reasoningParts: string[] = [];
    let usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let lastWarning: string | undefined;
    let exitError: unknown;

    try {
      for await (const evt of consume(opts)) {
        if (evt.type === "message") text = evt.text;
        else if (evt.type === "reasoning") reasoningParts.push(evt.text);
        else if (evt.type === "usage") usage = evt.usage;
        else if (evt.type === "warning") lastWarning = evt.message;
      }
    } catch (err) {
      exitError = err;
    }

    if (text !== undefined) {
      return { text, reasoningText: reasoningParts.length ? reasoningParts.join("\n\n") : undefined, usage, stopReason: "stop" };
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
        } else if (evt.type === "reasoning") {
          if (!evt.text) continue; // defensive: skip an empty summary chunk, same as claudePool.ts
          if (!roleSent) {
            roleSent = true;
            yield { kind: "role" };
          }
          // Same "whole chunk, no token deltas" situation as agent_message.
          yield { kind: "reasoning", text: evt.text };
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
