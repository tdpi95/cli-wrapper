import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { killWithGrace, timeoutErrorFor } from "./run.js";
import { CliExecutionError, TimeoutError } from "../errors.js";
import type { RunOptions, RunResult, StopReason, StreamChunk, Usage } from "../providers/types.js";

// --- Warm claude process pool --------------------------------------------
//
// claude -p supports --input-format stream-json, which keeps ONE process
// alive listening on stdin for more turns instead of exiting after a single
// reply (this is the same mechanism the Claude Agent SDK uses). Verified
// live (see the conversation this shipped from): a cold `claude -p` call
// costs ~1-3s of pure process boot/auth-check/tool-init overhead on top of
// the actual model API time; a warm process's 2nd+ turn costs ~30-50ms of
// overhead. Sending "/clear" as a plain turn resets the conversation for
// ~30ms (confirmed it actually wipes context, not just cosmetic) — so every
// request gets a genuinely blank slate, same as a fresh process, without
// paying to boot one.
//
// Design constraints this works within:
// - --model (and any extraFlags) are spawn-time-only — can't change them on
//   a live process. Pools are keyed by (cliModel, extraFlags), not by model
//   mapping id, so two mappings that happen to share both reuse one pool.
// - --system-prompt is ALSO spawn-time-only. Rather than one pool per
//   distinct system prompt (unbounded cardinality — every client could send
//   a different one), the system prompt is folded into the turn text itself
//   ("System: ...\n\nUser: ...", same approach providers/codex.ts already
//   uses since codex has no system-prompt flag at all). Trade-off: a system
//   prompt delivered as part of user-turn text may carry less weight with
//   the model than claude's dedicated --system-prompt channel. If that ever
//   matters in practice, the fix is keying pools by a system-prompt hash too
//   (spawning each with real --system-prompt) at the cost of more idle
//   processes when clients send many distinct system prompts.
// - A worker is retired (not reused) after a random 20-30 uses, so no
//   process lives forever accumulating state/memory from hundreds of
//   unrelated conversations — "prevent unnecessary leftovers" per the
//   request this shipped from. Retirement winds down cleanly (close stdin,
//   let the CLI exit on its own EOF) rather than SIGTERM, since nothing's
//   wrong with the process; a fallback timer force-kills it if it doesn't
//   exit within the grace period regardless.
// - A worker that times out, gets aborted (client disconnected mid-turn),
//   or exits unexpectedly is never returned to the pool — only ever killed.
//   Reusing a process we can't prove finished cleanly risks a later
//   request reading output that belongs to an abandoned turn.
// - Changing `cliWorkdir` on the settings page only affects newly spawned
//   workers — already-idle warm workers keep the --cwd they were spawned
//   with until they retire naturally or the server restarts.
// - Capped at MAX_TOTAL_WORKERS live processes, across all keys combined —
//   not per key. Measured live: an idle warm process holds ~280-320MB RSS,
//   so an uncapped burst (or one across many distinct cliModel/extraFlags
//   combinations) could exhaust host memory outright, unlike the pre-pool
//   design where each one-shot process exited the moment its request
//   finished. When at the cap and no idle worker matches the request's key,
//   the request queues (see `waiters`) rather than failing outright or
//   silently bypassing the cap with an untracked spawn — bounded by the
//   same opts.timeoutMs/opts.signal every in-flight turn already respects,
//   so a queued request can't hang past the request's normal timeout.
// - Idle workers are killed after IDLE_TIMEOUT_MS of not being reused. The
//   per-use retirement above bounds a busy worker's total lifetime, but
//   does nothing for a worker that goes idle and just sits there — without
//   this, a traffic burst that fills the pool and then goes quiet would
//   leave all of it (up to MAX_TOTAL_WORKERS processes) resident
//   indefinitely, holding memory for no ongoing benefit.

const CMD = "claude";
const MIN_USES_BEFORE_RETIRE = 20;
const MAX_USES_BEFORE_RETIRE = 30;
const RETIRE_GRACE_MS = 3000;
const MAX_TOTAL_WORKERS = 20;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

interface PoolKeyParts {
  cliModel: string;
  extraFlags?: string[];
}

interface TurnHandlers {
  onEvent(evt: any): void;
  onExit(code: number | null, signal: NodeJS.Signals | null): void;
}

interface Worker {
  key: string;
  child: ChildProcessWithoutNullStreams;
  usesRemaining: number;
  /** False once we know this process must never be reused (crash, timeout, abort). */
  alive: boolean;
  /** Set true on crash/timeout/abort so the caller's finally-block kills rather than releases. */
  broken: boolean;
  stderrTail: string;
  currentTurn: TurnHandlers | null;
  /** Set while idle in the pool; fires after IDLE_TIMEOUT_MS to retire an unused worker. Cleared on reacquire. */
  idleTimer: NodeJS.Timeout | null;
}

interface Waiter {
  key: string;
  spawnArgs: PoolKeyParts;
  workdir: string;
  settle(worker: Worker): void;
}

const idleWorkers = new Map<string, Worker[]>();
const allWorkers = new Set<Worker>();
const waiters: Waiter[] = [];

function poolKeyFor({ cliModel, extraFlags }: PoolKeyParts): string {
  return JSON.stringify([cliModel, extraFlags ?? []]);
}

function randomRetireAfter(): number {
  return MIN_USES_BEFORE_RETIRE + Math.floor(Math.random() * (MAX_USES_BEFORE_RETIRE - MIN_USES_BEFORE_RETIRE + 1));
}

function removeFromIdle(worker: Worker): void {
  const list = idleWorkers.get(worker.key);
  if (!list) return;
  const idx = list.indexOf(worker);
  if (idx !== -1) list.splice(idx, 1);
}

function spawnWorker(key: string, spawnArgs: PoolKeyParts, workdir: string): Worker {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--tools",
    "",
    "--permission-mode",
    "default",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--model",
    spawnArgs.cliModel,
    ...(spawnArgs.extraFlags ?? []),
  ];
  const child = spawn(CMD, args, { cwd: workdir, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  // Writing to stdin after the process has exited (a race between a check
  // and the actual write) would otherwise throw an unhandled 'error' event
  // and crash the whole server — swallow it, sendUserTurn's own try/catch
  // handles marking the worker broken.
  child.stdin.on("error", () => {});

  const worker: Worker = {
    key,
    child,
    usesRemaining: randomRetireAfter(),
    alive: true,
    broken: false,
    stderrTail: "",
    currentTurn: null,
    idleTimer: null,
  };

  child.stderr.on("data", (chunk: Buffer) => {
    worker.stderrTail = (worker.stderrTail + chunk.toString("utf8")).slice(-4096);
  });

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let evt: any;
    try {
      evt = JSON.parse(line);
    } catch {
      return; // ignore unparseable lines rather than tearing down an otherwise-good worker
    }
    worker.currentTurn?.onEvent(evt);
  });

  child.on("close", (code, signal) => {
    worker.alive = false;
    clearIdleTimer(worker);
    removeFromIdle(worker);
    allWorkers.delete(worker);
    worker.currentTurn?.onExit(code, signal);
    // A slot in the global cap just freed up — see if any queued request can use it.
    tryDispatchWaiters();
  });

  allWorkers.add(worker);
  return worker;
}

function clearIdleTimer(worker: Worker): void {
  if (worker.idleTimer) {
    clearTimeout(worker.idleTimer);
    worker.idleTimer = null;
  }
}

function popIdle(key: string): Worker | undefined {
  const list = idleWorkers.get(key);
  while (list && list.length > 0) {
    const worker = list.pop()!;
    if (worker.alive) {
      clearIdleTimer(worker);
      return worker;
    }
    // Already dead (closed after being removed from idle would have deleted
    // it too, but guard defensively against any ordering surprise).
  }
  return undefined;
}

/** Satisfies as many queued waiters as currently possible: a matching idle worker, or room under the global cap to spawn fresh. */
function tryDispatchWaiters(): void {
  for (let i = 0; i < waiters.length; ) {
    const waiter = waiters[i];
    const idle = popIdle(waiter.key);
    if (idle) {
      waiters.splice(i, 1);
      waiter.settle(idle);
      continue;
    }
    if (allWorkers.size < MAX_TOTAL_WORKERS) {
      const worker = spawnWorker(waiter.key, waiter.spawnArgs, waiter.workdir);
      waiters.splice(i, 1);
      waiter.settle(worker);
      continue;
    }
    i++;
  }
}

function removeWaiter(waiter: Waiter): void {
  const idx = waiters.indexOf(waiter);
  if (idx !== -1) waiters.splice(idx, 1);
}

/** Queues a request for a worker once the global cap frees a slot, or a same-key worker goes idle — whichever comes first. Bounded by the request's own timeout/abort. */
function waitForSlot(spawnArgs: PoolKeyParts, workdir: string, opts: RunOptions): Promise<Worker> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const waiter: Waiter = {
      key: poolKeyFor(spawnArgs),
      spawnArgs,
      workdir,
      settle(worker) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(worker);
      },
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      removeWaiter(waiter);
      reject(new TimeoutError(`Timed out after ${opts.timeoutMs}ms waiting for an available claude process (pool at its cap of ${MAX_TOTAL_WORKERS})`));
    }, opts.timeoutMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      removeWaiter(waiter);
      reject(new CliExecutionError("Request aborted while waiting for an available claude process"));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    function cleanup() {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }

    waiters.push(waiter);
  });
}

async function acquireWorker(spawnArgs: PoolKeyParts, workdir: string, opts: RunOptions): Promise<Worker> {
  const key = poolKeyFor(spawnArgs);
  const idle = popIdle(key);
  if (idle) return idle;
  if (allWorkers.size < MAX_TOTAL_WORKERS) {
    return spawnWorker(key, spawnArgs, workdir);
  }
  return waitForSlot(spawnArgs, workdir, opts);
}

/** Ends stdin so the CLI exits on its own EOF; force-kills only if it doesn't within the grace period. */
function retireGracefully(worker: Worker): void {
  worker.alive = false;
  clearIdleTimer(worker);
  removeFromIdle(worker);
  try {
    worker.child.stdin.end();
  } catch {
    // already closed; fall through to the fallback timer below
  }
  const fallback = setTimeout(() => {
    if (!worker.child.killed) killWithGrace(worker.child);
  }, RETIRE_GRACE_MS);
  worker.child.once("close", () => clearTimeout(fallback));
}

function hardKill(worker: Worker): void {
  worker.alive = false;
  clearIdleTimer(worker);
  removeFromIdle(worker);
  killWithGrace(worker.child);
}

/** Fires after IDLE_TIMEOUT_MS of a worker sitting unused in the pool. */
function evictIdleWorker(worker: Worker): void {
  worker.idleTimer = null;
  retireGracefully(worker);
}

/** After a successful turn: retire if this worker has hit its random use limit, otherwise return it to the pool. */
function releaseOrRetire(worker: Worker): void {
  if (!worker.alive) return;
  if (worker.usesRemaining <= 0) {
    retireGracefully(worker);
    return;
  }
  const list = idleWorkers.get(worker.key) ?? [];
  list.push(worker);
  idleWorkers.set(worker.key, list);
  worker.idleTimer = setTimeout(() => evictIdleWorker(worker), IDLE_TIMEOUT_MS);
  // A same-key request may already be queued waiting for exactly this worker.
  tryDispatchWaiters();
}

function finishWorker(worker: Worker): void {
  if (worker.broken || !worker.alive) hardKill(worker);
  else releaseOrRetire(worker);
}

/** Kills every pooled claude process (idle or mid-turn). Call on server shutdown so none are left running. */
export function shutdownClaudePool(): void {
  for (const worker of allWorkers) {
    hardKill(worker);
  }
  // Any requests still queued in `waiters` are moot — server.ts calls
  // process.exit() right after this, which drops them along with
  // everything else in flight; nothing to hand them a worker anyway.
}

function sendUserTurn(worker: Worker, text: string): void {
  try {
    worker.child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n");
  } catch (err) {
    worker.broken = true;
    worker.currentTurn?.onExit(null, null);
  }
}

/** Resolves with the turn's "result" event; forwards text deltas via onDelta as they stream in. Rejects only if the process itself dies mid-turn. */
function waitForResult(worker: Worker, onDelta?: (text: string) => void): Promise<any> {
  return new Promise((resolve, reject) => {
    worker.currentTurn = {
      onEvent(evt) {
        if (evt.type === "stream_event") {
          const inner = evt.event;
          if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta") {
            onDelta?.(inner.delta.text);
          }
        } else if (evt.type === "result") {
          worker.currentTurn = null;
          resolve(evt);
        }
        // "system"/init, "conversation_reset", "assistant" (full snapshot), "rate_limit_event": ignore.
      },
      onExit(code, signal) {
        worker.currentTurn = null;
        worker.broken = true;
        reject(
          new CliExecutionError(
            `claude (warm process) exited unexpectedly (code ${code}, signal ${signal}): ${worker.stderrTail || "(no stderr output)"}`
          )
        );
      },
    };
  });
}

/** Races a turn promise against the request's timeout and abort signal, killing the worker if either fires first. */
function raceWithTimeoutAndAbort<T>(promise: Promise<T>, worker: Worker, opts: RunOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      worker.broken = true;
      killWithGrace(worker.child);
      reject(timeoutErrorFor(CMD, opts.timeoutMs));
    }, opts.timeoutMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      worker.broken = true;
      killWithGrace(worker.child);
      reject(new CliExecutionError("Request aborted"));
    };
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

function buildTurnText(opts: RunOptions): string {
  // --system-prompt is spawn-time-only (see the module comment above) — fold
  // it into the turn text instead, same approach providers/codex.ts uses.
  if (opts.systemPrompt.trim() === "") return opts.transcript;
  return `System: ${opts.systemPrompt}\n\n${opts.transcript}`;
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

async function clearConversation(worker: Worker, opts: RunOptions): Promise<void> {
  // waitForResult wires up worker.currentTurn synchronously (before this
  // function's Promise executor even returns), so a write that fails
  // synchronously in sendUserTurn can still reject via onExit — call it
  // second, not first.
  const result = waitForResult(worker);
  sendUserTurn(worker, "/clear");
  await raceWithTimeoutAndAbort(result, worker, opts);
}

export async function runWarmNonStreaming(opts: RunOptions): Promise<RunResult> {
  const worker = await acquireWorker({ cliModel: opts.cliModel, extraFlags: opts.extraFlags }, opts.workdir, opts);
  try {
    await clearConversation(worker, opts);

    const result = waitForResult(worker);
    sendUserTurn(worker, buildTurnText(opts));
    const evt = await raceWithTimeoutAndAbort(result, worker, opts);
    worker.usesRemaining--;

    if (evt.is_error) {
      throw new CliExecutionError(evt.result || "claude reported an error");
    }
    return {
      text: evt.result,
      usage: usageFrom(evt.usage),
      stopReason: mapStopReason(evt.stop_reason, false),
    };
  } finally {
    finishWorker(worker);
  }
}

export async function* runWarmStreaming(opts: RunOptions): AsyncIterable<StreamChunk> {
  const queue = new AsyncEventQueue<StreamChunk>();
  let roleSent = false;

  (async () => {
    // acquireWorker can itself fail (e.g. timed out queued behind the pool
    // cap) before any process exists — only finishWorker() if we actually
    // got one, and either way surface it as an error chunk rather than
    // throwing out of the generator, matching codex.ts's error-chunk style.
    let worker: Worker;
    try {
      worker = await acquireWorker({ cliModel: opts.cliModel, extraFlags: opts.extraFlags }, opts.workdir, opts);
    } catch (err) {
      queue.push({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      queue.end();
      return;
    }

    try {
      await clearConversation(worker, opts);

      const result = waitForResult(worker, (text) => {
        if (!roleSent) {
          roleSent = true;
          queue.push({ kind: "role" });
        }
        queue.push({ kind: "delta", text });
      });
      sendUserTurn(worker, buildTurnText(opts));
      const evt = await raceWithTimeoutAndAbort(result, worker, opts);
      worker.usesRemaining--;

      if (evt.is_error) {
        queue.push({ kind: "error", message: evt.result || "claude reported an error" });
      } else {
        queue.push({ kind: "done", usage: usageFrom(evt.usage), stopReason: mapStopReason(evt.stop_reason, false) });
      }
    } catch (err) {
      queue.push({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      finishWorker(worker);
      queue.end();
    }
  })();

  yield* queue;
}

/** Minimal push/pull async queue bridging the worker's callback-style event delivery into an async generator. */
class AsyncEventQueue<T> {
  private items: T[] = [];
  private resolvers: ((result: IteratorResult<T>) => void)[] = [];
  private ended = false;

  push(item: T): void {
    const resolver = this.resolvers.shift();
    if (resolver) resolver({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    this.ended = true;
    while (this.resolvers.length > 0) {
      this.resolvers.shift()!({ value: undefined as unknown as T, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift()!;
        continue;
      }
      if (this.ended) return;
      const result = await new Promise<IteratorResult<T>>((resolve) => this.resolvers.push(resolve));
      if (result.done) return;
      yield result.value;
    }
  }
}
