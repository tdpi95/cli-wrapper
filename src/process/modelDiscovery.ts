import { spawn } from "node:child_process";
import readline from "node:readline";
import { killWithGrace } from "./run.js";
import { codexProxyBypassEnv } from "./codexProxyBypass.js";
import { codexIsolationArgs } from "./codexIsolation.js";

// Feeds the settings page's cliModel dropdown. See AGENTS.md's "Model
// discovery" section for what each provider can and can't report.
//
// - codex: the account's real model list, from `codex app-server`'s
//   `model/list`. A throwaway process, not the warm pool's daemon: the pool is
//   opt-in, and this has to work with it off.
// - claude: no CLI introspection exists, so this is a fixed list of the
//   aliases `claude --help` documents. A full model id also works as
//   cliModel; the settings input stays free-text for that.

export interface DiscoveredModel {
  id: string;
  isDefault?: boolean;
  hidden?: boolean;
  supportedReasoningEfforts?: string[];
}

export interface ModelDiscoveryResult {
  provider: "claude" | "codex";
  /** "cli" = asked the installed CLI; "static" = a hardcoded list. */
  source: "cli" | "static";
  models: DiscoveredModel[];
  /** Set (with an empty `models`) when discovery failed, so the UI can say why. */
  error?: string;
}

const CLAUDE_ALIASES = ["fable", "opus", "sonnet", "haiku"];
const CODEX_LIST_TIMEOUT_MS = 20_000;
// Spawning codex costs seconds, and the settings page asks every time it's
// opened. A model list this stable doesn't need to be fresher than this; the
// UI's refresh button passes `force`.
const CACHE_TTL_MS = 10 * 60_000;

let codexCache: { at: number; result: ModelDiscoveryResult } | undefined;
let codexInFlight: Promise<ModelDiscoveryResult> | undefined;

function claudeModels(): ModelDiscoveryResult {
  return {
    provider: "claude",
    source: "static",
    models: CLAUDE_ALIASES.map((id) => ({ id, supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] })),
  };
}

function listCodexModels(): Promise<ModelDiscoveryResult> {
  return new Promise((resolve) => {
    const bypass = codexProxyBypassEnv();
    // Isolation args so this process doesn't start the operator's configured
    // MCP servers/plugins just to answer a list request.
    const child = spawn("codex", ["app-server", ...codexIsolationArgs(false)], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: bypass ? { ...process.env, ...bypass } : undefined,
    });
    child.stdin.on("error", () => {});

    let settled = false;
    let stderrTail = "";
    const finish = (result: ModelDiscoveryResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killWithGrace(child);
      resolve(result);
    };
    const fail = (error: string) => finish({ provider: "codex", source: "cli", models: [], error });
    const timer = setTimeout(() => fail(`codex model/list timed out after ${CODEX_LIST_TIMEOUT_MS / 1000}s`), CODEX_LIST_TIMEOUT_MS);

    child.on("error", (err) => fail(`could not start codex: ${err.message}`));
    child.on("exit", (code) => fail(`codex app-server exited (code ${code}): ${stderrTail.trim() || "(no stderr output)"}`));
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-1024);
    });

    const write = (msg: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id === 1) {
        if (msg.error) return fail(`codex initialize failed: ${msg.error.message ?? JSON.stringify(msg.error)}`);
        // Same handshake as codexAppServer.ts: initialize, then initialized.
        write({ method: "initialized" });
        write({ id: 2, method: "model/list", params: { includeHidden: true } });
      } else if (msg.id === 2) {
        if (msg.error) return fail(`codex model/list failed: ${msg.error.message ?? JSON.stringify(msg.error)}`);
        const data: any[] = Array.isArray(msg.result?.data) ? msg.result.data : [];
        finish({
          provider: "codex",
          source: "cli",
          models: data
            .filter((m) => typeof m?.id === "string")
            .map((m) => ({
              id: m.id,
              isDefault: !!m.isDefault,
              hidden: !!m.hidden,
              supportedReasoningEfforts: (m.supportedReasoningEfforts ?? [])
                .map((e: any) => (typeof e === "string" ? e : e?.reasoningEffort))
                .filter((e: unknown): e is string => typeof e === "string"),
            })),
        });
      }
    });

    write({ id: 1, method: "initialize", params: { clientInfo: { name: "cli-wrapper", title: "cli-wrapper", version: "1.0.0" } } });
  });
}

/**
 * Failures aren't cached (a codex that wasn't logged in a minute ago may be
 * now), and concurrent callers share one spawn.
 */
async function codexModels(force: boolean): Promise<ModelDiscoveryResult> {
  if (!force && codexCache && Date.now() - codexCache.at < CACHE_TTL_MS) return codexCache.result;
  codexInFlight ??= listCodexModels().finally(() => {
    codexInFlight = undefined;
  });
  const result = await codexInFlight;
  if (!result.error) codexCache = { at: Date.now(), result };
  return result;
}

export function discoverModels(provider: "claude" | "codex", force = false): Promise<ModelDiscoveryResult> {
  return provider === "claude" ? Promise.resolve(claudeModels()) : codexModels(force);
}
