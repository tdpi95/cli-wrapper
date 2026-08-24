import { spawn } from "node:child_process";
import readline from "node:readline";
import { TimeoutError } from "../errors.js";

export interface ManagedProcess {
  stdout: readline.Interface;
  /** Resolves when the process exits, with its exit code/signal. Never rejects. */
  whenExited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Tail of stderr, for inclusion in error messages. Populated as the process runs. */
  stderrTail(): string;
  /** True once the process was killed due to timeout. */
  didTimeout(): boolean;
}

const GRACE_PERIOD_MS = 3000;
const STDERR_TAIL_LIMIT = 4096;

/**
 * SIGTERM, then SIGKILL after a grace period if it hasn't exited by then.
 * The one place "forcibly kill a child process" is implemented — both
 * spawnManaged (one-shot processes below) and process/claudePool.ts's warm
 * workers route through this rather than each rolling their own SIGTERM/
 * SIGKILL timer. Safe to call on an already-exited process (kill() on a dead
 * pid is a no-op, not a throw).
 */
export function killWithGrace(proc: { kill(signal: NodeJS.Signals): boolean; killed: boolean }, graceMs = GRACE_PERIOD_MS): void {
  proc.kill("SIGTERM");
  setTimeout(() => {
    if (!proc.killed) proc.kill("SIGKILL");
  }, graceMs);
}

/**
 * Spawns a CLI, enforces a hard timeout (SIGTERM then SIGKILL), and kills the
 * process if the given AbortSignal fires (wired to the HTTP request's
 * 'close' event so abandoned subprocesses don't accumulate). This is the
 * single place the "never let a subprocess hang" requirement is enforced,
 * independent of whatever the CLI's own permission/sandbox flags do.
 */
export function spawnManaged(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal }
): ManagedProcess {
  const proc = spawn(cmd, args, {
    cwd: opts.cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let timedOut = false;
  let stderrTail = "";
  proc.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_LIMIT);
  });

  let killTimer: NodeJS.Timeout | undefined;

  const clearTimers = () => {
    if (killTimer) clearTimeout(killTimer);
  };

  const onAbort = () => killWithGrace(proc);
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  killTimer = setTimeout(() => {
    timedOut = true;
    killWithGrace(proc);
  }, opts.timeoutMs);

  const whenExited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    proc.on("close", (code, signal) => {
      clearTimers();
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, signal });
    });
  });

  const stdout = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });

  return {
    stdout,
    whenExited,
    stderrTail: () => stderrTail,
    didTimeout: () => timedOut,
  };
}

export function timeoutErrorFor(cmd: string, timeoutMs: number): TimeoutError {
  return new TimeoutError(`${cmd} did not respond within ${timeoutMs}ms and was killed`);
}
