import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { killWithGrace, timeoutErrorFor } from "./run.js";
import { codexProxyBypassEnv } from "./codexProxyBypass.js";
import { AsyncEventQueue } from "./asyncEventQueue.js";
import { getSettings } from "../config.js";
import { CliExecutionError } from "../errors.js";
import type { RunOptions, RunResult, StopReason, StreamChunk, Usage } from "../providers/types.js";

// --- Warm codex app-server pool -------------------------------------------
//
// EXPERIMENTAL — off by default (WrapperSettings.codexUseWarmPool). See
// AGENTS.md's "Warm codex app-server pool" section for the full
// investigation and verified-live numbers before flipping this on.
//
// `codex exec` has no stdin-keep-alive mode (no --input-format flag exists on
// it, unlike claude -p), so process/claudePool.ts's approach doesn't port
// directly. `codex app-server` is a different, JSON-RPC daemon: one process
// stays alive over stdio, and any number of independent "threads" (each an
// isolated, ephemeral conversation) can be started/run/finished on it
// without spawning a new OS process per request. Confirmed live: 4 fully
// concurrent turns on ONE daemon completed in ~5s total (not additive), each
// in its own thread with no state bleed between them, and a warm daemon's
// per-turn overhead (~4-6s incl. real model latency) beats a fresh `codex
// exec` process (~6-9s) even with the proxy bypass on — the daemon's own
// CLI-boot/auth/model-catalog cost is paid once at daemon spawn, not per
// request.
//
// Per the protocol's own README (codex-rs/app-server/README.md, upstream):
// it's the interface backing OpenAI's own Codex VS Code extension, so the
// core thread/turn lifecycle used here isn't a throwaway toy — but nothing
// in that doc promises method names/shapes stay stable across codex
// releases, and there's no official client library. That's the reason this
// stays settings-gated with a working fallback (providers/codex.ts's
// exec-based path) rather than fully replacing it the way claudePool.ts
// replaced one-shot claude spawning.
//
// Design constraints worth knowing before touching this file:
// - Unlike claude, nothing here is spawn-time-only: model, sandbox, cwd,
//   reasoning effort/summary, and web-search are all turn/thread-time
//   parameters in the JSON-RPC protocol (thread/start's `model`/`cwd`/
//   `sandbox`/`config`, turn/start's `effort`/`summary`). So daemons are NOT
//   keyed by (cliModel, extraFlags, reasoningEffort, enableWebSearch) the way
//   claude's pool is — any daemon can serve any request. The pool is just a
//   fixed number of interchangeable daemons (WrapperSettings.codexPoolSize),
//   picked by least-in-flight-turns, not by a matching key.
// - Every request gets its own ephemeral thread (`thread/start` with
//   `ephemeral: true`) and exactly one turn — this is what gives the same
//   statelessness guarantee as a fresh `codex exec` process, without paying
//   to boot one. Ephemeral threads are never explicitly deleted: verified
//   live that `thread/delete` on one errors ("thread is not persisted and
//   cannot be deleted") — they're in-memory only and the daemon cleans them
//   up on its own once nothing references them anymore.
// - The protocol requires a handshake: `initialize` (a request, awaited),
//   then an `initialized` notification (no id) before any other call —
//   spelled out in the upstream README. Skipping the notification happened
//   to still work against the codex version this was built against, but
//   it's a real spec requirement, not a nicety, so it's sent regardless.
// - No hard per-daemon concurrency cap is enforced here — verified live that
//   several concurrent turns on one daemon work fine (isolated ephemeral
//   threads, no shared mutable state to race on). `codexPoolSize` bounds the
//   number of OS processes (and blast radius if one crashes — see below),
//   not concurrency; a daemon at or past the upstream server's own ingress
//   limit surfaces that as a JSON-RPC `-32001` error (documented upstream),
//   which is retried on a different/fresh daemon a bounded number of times
//   (see MAX_OVERLOAD_RETRIES) rather than failing the request outright.
// - A daemon that exits unexpectedly (crash, killed, EOF) takes down every
//   turn currently multiplexed on it, not just one request — the trade-off
//   for sharing one process across concurrent requests. `codexPoolSize > 1`
//   bounds how much of the total traffic that blast radius can hit at once;
//   a dead daemon's slot is simply respawned lazily the next time
//   acquireDaemon() needs it, no proactive restart timer.
// - A turn that times out or gets aborted (client disconnected) sends
//   `turn/interrupt` to ask the daemon to cancel it server-side, then the
//   request fails immediately — it does NOT wait for the interrupt to
//   confirm, matching every other timeout path in this codebase ("never
//   hang past the request's own timeout"). Unlike claude's pool, the daemon
//   itself is never killed for one turn's timeout, since it's shared
//   infrastructure serving other concurrent requests — only that one
//   ephemeral thread is affected.
// - No idle-eviction or per-daemon use-count retirement (contrast
//   claudePool.ts's IDLE_TIMEOUT_MS/random 20-30-use retirement) — daemons
//   don't accumulate client-visible conversation state the way a claude
//   worker without a `/clear` would, so there's no "went stale" condition to
//   guard against, just ordinary long-lived-process resource growth. Not
//   proactively bounded yet; a documented known gap, see AGENTS.md.

const CMD = "codex";
const MAX_OVERLOAD_RETRIES = 2;
const OVERLOAD_BACKOFF_MS = 500;
/** JSON-RPC error code the app-server protocol documents for "request ingress saturated" (upstream README). */
const OVERLOAD_ERROR_CODE = -32001;

interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message?: string };
}

interface PendingRpc {
  resolve(v: any): void;
  reject(err: Error): void;
}

interface TurnTracker {
  onNotif(msg: JsonRpcMessage): void;
  onDaemonDied(reason: string): void;
}

interface Daemon {
  id: number;
  child: ChildProcessWithoutNullStreams;
  alive: boolean;
  ready: Promise<void>;
  nextRpcId: number;
  pending: Map<number, PendingRpc>;
  turnHandlers: Map<string, TurnTracker>;
  inFlightTurns: number;
  turnsServed: number;
  stderrTail: string;
}

let nextDaemonId = 1;
const daemons: Daemon[] = [];

function send(daemon: Daemon, method: string, params: unknown): Promise<any> {
  const id = daemon.nextRpcId++;
  return new Promise((resolve, reject) => {
    daemon.pending.set(id, { resolve, reject });
    try {
      daemon.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    } catch (err) {
      daemon.pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function notify(daemon: Daemon, method: string): void {
  try {
    daemon.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  } catch {
    // Best-effort — if stdin is already gone the daemon is on its way out
    // anyway; the child's 'exit' handler below is what actually tears things
    // down and rejects in-flight callers.
  }
}

function isOverloadError(err: unknown): boolean {
  return err instanceof CliExecutionError && err.message.includes(`code ${OVERLOAD_ERROR_CODE}`);
}

function spawnDaemon(): Daemon {
  const bypass = codexProxyBypassEnv();
  const child = spawn(CMD, ["app-server"], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: bypass ? { ...process.env, ...bypass } : undefined,
  });
  // Same race as claudePool.ts's workers: writing to stdin after the process
  // has already exited would otherwise throw an unhandled 'error' event and
  // crash the whole server.
  child.stdin.on("error", () => {});

  const daemon: Daemon = {
    id: nextDaemonId++,
    child,
    alive: true,
    ready: undefined as unknown as Promise<void>,
    nextRpcId: 1,
    pending: new Map(),
    turnHandlers: new Map(),
    inFlightTurns: 0,
    turnsServed: 0,
    stderrTail: "",
  };

  child.stderr.on("data", (chunk: Buffer) => {
    daemon.stderrTail = (daemon.stderrTail + chunk.toString("utf8")).slice(-4096);
  });

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ignore unparseable lines rather than tearing down an otherwise-good daemon
    }
    if (msg.id !== undefined && daemon.pending.has(msg.id)) {
      const { resolve, reject } = daemon.pending.get(msg.id)!;
      daemon.pending.delete(msg.id);
      if (msg.error) {
        reject(new CliExecutionError(`codex app-server error (code ${msg.error.code ?? "?"}): ${msg.error.message ?? JSON.stringify(msg.error)}`));
      } else {
        resolve(msg.result);
      }
      return;
    }
    // Notification — every one this file cares about carries threadId.
    const threadId = msg.params?.threadId;
    if (threadId) daemon.turnHandlers.get(threadId)?.onNotif(msg);
  });

  child.on("exit", (code, signal) => {
    daemon.alive = false;
    const reason = `codex app-server daemon exited unexpectedly (code ${code}, signal ${signal}): ${daemon.stderrTail || "(no stderr output)"}`;
    for (const { reject } of daemon.pending.values()) reject(new CliExecutionError(reason));
    daemon.pending.clear();
    for (const tracker of daemon.turnHandlers.values()) tracker.onDaemonDied(reason);
    daemon.turnHandlers.clear();
    const idx = daemons.indexOf(daemon);
    if (idx !== -1) daemons.splice(idx, 1);
  });

  // Required handshake (see upstream codex-rs/app-server/README.md): a
  // request, awaited, then an "initialized" notification (no id) before any
  // other call. daemon.ready gates acquireDaemon() on this completing.
  daemon.ready = send(daemon, "initialize", {
    clientInfo: { name: "cli-wrapper", title: "cli-wrapper", version: "1.0.0" },
  }).then(() => {
    notify(daemon, "initialized");
  });

  daemons.push(daemon);
  return daemon;
}

/**
 * Picks an existing idle daemon, or spawns a fresh one if the pool has room,
 * or falls back to the least-busy existing daemon at the pool cap. The
 * increment happens synchronously (before any `await`) so a burst of
 * concurrent calls in the same tick can't all pile onto the same
 * just-spawned "idle" daemon — see the module comment for why no further
 * concurrency cap is needed beyond that.
 */
function acquireDaemon(): Promise<Daemon> {
  const poolSize = Math.max(1, getSettings().codexPoolSize);
  const alive = daemons.filter((d) => d.alive);
  const idle = alive.find((d) => d.inFlightTurns === 0);
  const daemon = idle ?? (alive.length < poolSize ? spawnDaemon() : alive.reduce((least, d) => (d.inFlightTurns < least.inFlightTurns ? d : least)));
  daemon.inFlightTurns++;
  return daemon.ready.then(
    () => daemon,
    (err) => {
      daemon.inFlightTurns--;
      throw err;
    }
  );
}

function releaseDaemon(daemon: Daemon): void {
  daemon.inFlightTurns = Math.max(0, daemon.inFlightTurns - 1);
}

function buildTurnText(opts: RunOptions): string {
  // codex has no system-prompt flag/field, same situation as the legacy exec
  // path (providers/codex.ts's buildPrompt) — prepend a labeled block instead.
  if (opts.systemPrompt.trim() === "") return opts.transcript;
  return `System: ${opts.systemPrompt}\n\n${opts.transcript}`;
}

/**
 * Starts a fresh ephemeral thread and its one turn. Retries on the
 * documented -32001 "ingress saturated" error (a different/fresh daemon each
 * retry, since the one that's overloaded staying overloaded is the likely
 * case) up to MAX_OVERLOAD_RETRIES times before giving up.
 */
async function startEphemeralTurn(opts: RunOptions): Promise<{ daemon: Daemon; threadId: string; turnId: string }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_OVERLOAD_RETRIES; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, OVERLOAD_BACKOFF_MS));
    const daemon = await acquireDaemon();
    try {
      const threadStart = await send(daemon, "thread/start", {
        ephemeral: true,
        model: opts.cliModel,
        cwd: opts.workdir,
        sandbox: "read-only",
        config: {
          // Same leak fix as the legacy exec path (providers/codex.ts) — see
          // AGENTS.md gotcha #6.
          project_doc_max_bytes: 0,
          ...(opts.enableWebSearch ? { tools: { web_search: true } } : {}),
        },
      });
      const threadId = threadStart.thread.id;
      const turnStart = await send(daemon, "turn/start", {
        threadId,
        input: [{ type: "text", text: buildTurnText(opts) }],
        ...(opts.reasoningEffort ? { effort: opts.reasoningEffort, summary: "detailed" } : {}),
      });
      return { daemon, threadId, turnId: turnStart.turn.id };
    } catch (err) {
      releaseDaemon(daemon);
      if (!isOverloadError(err)) throw err;
      lastErr = err;
      // Loop again on a fresh acquireDaemon() call — deliberately not the
      // same daemon, since an overloaded daemon is likely to still be
      // overloaded a moment later.
    }
  }
  throw lastErr instanceof Error ? lastErr : new CliExecutionError("codex app-server pool is overloaded");
}

interface TurnDeltaCallbacks {
  onTextDelta?: (text: string) => void;
  /** Token-level reasoning summary deltas (item/reasoning/summaryTextDelta) — finer-grained than the legacy exec path's whole-chunk reasoning events. */
  onReasoningDelta?: (text: string) => void;
}

interface CodexTurn {
  status: "completed" | "interrupted" | "failed" | "inProgress";
  items: Array<{ type: string; text?: string; summary?: string[] }>;
  error?: { message: string } | null;
}

function usageFrom(tokenUsage: any): Usage {
  const u = tokenUsage?.last ?? {};
  return { promptTokens: u.inputTokens ?? 0, completionTokens: u.outputTokens ?? 0, totalTokens: u.totalTokens ?? 0 };
}

/** Resolves with the turn's terminal state once `turn/completed` arrives; forwards deltas via the callbacks as they stream in. Rejects only if the daemon itself dies mid-turn. */
function waitForTurn(daemon: Daemon, threadId: string, callbacks?: TurnDeltaCallbacks): Promise<{ turn: CodexTurn; usage: Usage }> {
  return new Promise((resolve, reject) => {
    let usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    daemon.turnHandlers.set(threadId, {
      onNotif(msg) {
        switch (msg.method) {
          case "item/agentMessage/delta":
            callbacks?.onTextDelta?.(msg.params.delta ?? "");
            break;
          case "item/reasoning/summaryTextDelta":
            callbacks?.onReasoningDelta?.(msg.params.delta ?? "");
            break;
          case "thread/tokenUsage/updated":
            usage = usageFrom(msg.params.tokenUsage);
            break;
          case "turn/completed":
            daemon.turnHandlers.delete(threadId);
            resolve({ turn: msg.params.turn, usage });
            break;
          // "error" (transient reconnect/websocket-fallback warnings — same
          // gotcha #5 noise as the legacy exec path), "warning", "item/started",
          // "thread/status/changed", "account/rateLimits/updated",
          // "mcpServer/startupStatus/updated": ignore. Only the turn's own
          // terminal status/error (below) determines success or failure, not
          // incidental transport noise — same policy as the exec path.
        }
      },
      onDaemonDied(reason) {
        daemon.turnHandlers.delete(threadId);
        reject(new CliExecutionError(reason));
      },
    });
  });
}

/** Races a turn against the request's timeout/abort. Interrupts the turn server-side (best-effort, not awaited) rather than killing the shared daemon. */
function raceWithTimeoutAndAbort<T>(promise: Promise<T>, daemon: Daemon, threadId: string, turnId: string, opts: RunOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const bail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      daemon.turnHandlers.delete(threadId);
      send(daemon, "turn/interrupt", { threadId, turnId }).catch(() => {});
      reject(err);
    };

    const timer = setTimeout(() => bail(timeoutErrorFor(CMD, opts.timeoutMs)), opts.timeoutMs);
    const onAbort = () => bail(new CliExecutionError("Request aborted"));
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    function cleanup() {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }

    promise.then(
      (v) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(e);
      }
    );
  });
}

function mapStopReason(turn: CodexTurn): StopReason {
  return turn.status === "failed" ? "error" : "stop";
}

function agentMessageTextFrom(turn: CodexTurn): string | undefined {
  return turn.items.find((i) => i.type === "agentMessage")?.text;
}

function reasoningTextFrom(turn: CodexTurn): string | undefined {
  const parts = turn.items.filter((i) => i.type === "reasoning" && i.summary?.length).map((i) => i.summary!.join("\n\n"));
  return parts.length ? parts.join("\n\n") : undefined;
}

export async function runAppServerNonStreaming(opts: RunOptions): Promise<RunResult> {
  const { daemon, threadId, turnId } = await startEphemeralTurn(opts);
  try {
    let reasoningText = "";
    const result = waitForTurn(daemon, threadId, {
      onReasoningDelta: (text) => {
        reasoningText += text;
      },
    });
    const { turn, usage } = await raceWithTimeoutAndAbort(result, daemon, threadId, turnId, opts);
    daemon.turnsServed++;

    if (turn.status === "failed") {
      throw new CliExecutionError(turn.error?.message ?? "codex reported an error");
    }
    const text = agentMessageTextFrom(turn);
    if (text === undefined) {
      throw new CliExecutionError("codex produced no output");
    }
    return {
      text,
      reasoningText: reasoningText || reasoningTextFrom(turn),
      usage,
      stopReason: mapStopReason(turn),
    };
  } finally {
    releaseDaemon(daemon);
  }
}

export async function* runAppServerStreaming(opts: RunOptions): AsyncIterable<StreamChunk> {
  const queue = new AsyncEventQueue<StreamChunk>();
  let roleSent = false;

  (async () => {
    let daemon: Daemon;
    let threadId: string;
    let turnId: string;
    try {
      ({ daemon, threadId, turnId } = await startEphemeralTurn(opts));
    } catch (err) {
      queue.push({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      queue.end();
      return;
    }

    try {
      const result = waitForTurn(daemon, threadId, {
        onTextDelta: (text) => {
          if (!roleSent) {
            roleSent = true;
            queue.push({ kind: "role" });
          }
          queue.push({ kind: "delta", text });
        },
        onReasoningDelta: (text) => {
          if (!text) return;
          if (!roleSent) {
            roleSent = true;
            queue.push({ kind: "role" });
          }
          queue.push({ kind: "reasoning", text });
        },
      });
      const { turn, usage } = await raceWithTimeoutAndAbort(result, daemon, threadId, turnId, opts);
      daemon.turnsServed++;

      if (turn.status === "failed") {
        queue.push({ kind: "error", message: turn.error?.message ?? "codex reported an error" });
      } else if (agentMessageTextFrom(turn) === undefined) {
        queue.push({ kind: "error", message: "codex produced no output" });
      } else {
        queue.push({ kind: "done", usage, stopReason: mapStopReason(turn) });
      }
    } catch (err) {
      queue.push({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      releaseDaemon(daemon);
      queue.end();
    }
  })();

  yield* queue;
}

/** Kills every pooled codex app-server daemon. Call on server shutdown so none are left running. */
export function shutdownCodexAppServerPool(): void {
  for (const daemon of daemons.slice()) {
    daemon.alive = false;
    killWithGrace(daemon.child);
  }
}

export interface CodexDaemonStatus {
  pid: number | undefined;
  /** Concurrently in-flight turns right now — can be >1; daemons aren't limited to one turn at a time. */
  inFlightTurns: number;
  turnsServed: number;
}

export interface CodexPoolStatus {
  enabled: boolean;
  poolSize: number;
  totalDaemons: number;
  totalInFlightTurns: number;
  daemons: CodexDaemonStatus[];
}

/** A point-in-time snapshot for the settings page — see routes/settings.ts's `/api/settings/codex-pool-status`. Reads live module state, nothing cached. */
export function getCodexPoolStatus(): CodexPoolStatus {
  return {
    enabled: getSettings().codexUseWarmPool,
    poolSize: getSettings().codexPoolSize,
    totalDaemons: daemons.length,
    totalInFlightTurns: daemons.reduce((sum, d) => sum + d.inFlightTurns, 0),
    daemons: daemons.map((d) => ({ pid: d.child.pid, inFlightTurns: d.inFlightTurns, turnsServed: d.turnsServed })),
  };
}
