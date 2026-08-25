export type ProviderName = "claude" | "codex";

/**
 * Shared across both providers even though neither CLI accepts all six —
 * claude's `--effort` takes low/medium/high/xhigh/max (no "minimal"), codex's
 * `-c model_reasoning_effort=` takes minimal/low/medium/high (no
 * xhigh/max). Same laissez-faire approach as `cliModel` (see AGENTS.md
 * gotcha #4): this only catches typos, not provider/account-invalid values —
 * picking a value the mapping's own provider doesn't support surfaces as a
 * CLI-level error at request time, not a config-save-time rejection.
 */
export const REASONING_EFFORT_VALUES = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number];

export interface ModelMapping {
  /** Client-facing model name, e.g. "claude-sonnet-5". Used as the OpenAI `model` field. */
  id: string;
  provider: ProviderName;
  /** Value passed to --model / -m on the underlying CLI. */
  cliModel: string;
  /** Extra flags appended verbatim to the spawn argv. */
  extraFlags?: string[];
  description?: string;
  /**
   * Default reasoning effort for this mapping. Omitted = today's behavior,
   * unchanged: no --effort / -c model_reasoning_effort= passed at all.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * If true, a request's `reasoning_effort` field (OpenAI's own chat.completions
   * field name for reasoning models) overrides `reasoningEffort` above for that
   * one request. Default false — matches the existing "unsupported OpenAI
   * fields are silently ignored" convention when a client sends this but the
   * mapping hasn't opted in, rather than erroring.
   */
  allowReasoningEffortOverride?: boolean;
  /**
   * Grants this mapping's CLI its own built-in web search tool. Each provider
   * wires this to its own mechanism (see AGENTS.md's "Web search tool"
   * section for the full investigation behind both):
   *   - claude: `--tools "WebSearch" --permission-mode "bypassPermissions"`
   *     at spawn time (process/claudePool.ts's spawnWorker). Executed
   *     server-side by Anthropic (billed as
   *     `server_tool_use.web_search_requests`, not a local subprocess/file
   *     write) — a deliberate, narrow exception to the "Tool use ... is an
   *     intentional non-goal" note elsewhere in AGENTS.md, not a reversal of it.
   *   - codex: `-c tools.web_search=true` (providers/codex.ts's args()).
   *     codex exec never prompts for approval regardless (see gotcha #3), so
   *     there's no permission-mode equivalent to pick here.
   * Omitted/false = today's behavior, unchanged: no tools available to
   * either CLI. Whether the account/model actually supports it isn't
   * validated for either provider — same laissez-faire approach as
   * `cliModel`/`reasoningEffort` (see gotcha #4).
   */
  enableWebSearch?: boolean;
}

/**
 * Everything that used to live in env vars, now editable at runtime from the
 * settings page (GET/PUT /api/settings/config) instead of requiring a
 * restart with different env vars. Only `PORT`/`CONFIG_PATH`/`SETTINGS_PORT`
 * remain env-only — see env.ts for why (bootstrap values needed before
 * config.json can even be located/read, or — for `SETTINGS_PORT` — needed to
 * pick which port the settings surface listens on before that surface even
 * exists to be edited from). See AGENTS.md's "Two ports, by design" section
 * for the full rationale behind the settings/API port split.
 */
export interface WrapperSettings {
  /**
   * Shared bearer token required for `/v1/*`. An empty string disables auth
   * on those routes entirely — an explicit, visible opt-out (never the
   * silent default; see config.ts's auto-generation on first run).
   */
  apiKey: string;
  /**
   * Port for the OpenAI-compatible API (`/v1/*`) only — NOT the settings
   * surface, which listens on its own port instead (env `SETTINGS_PORT`,
   * default 8868; see env.ts). Only takes effect on the next restart (the
   * server is already listening by the time this can be read). Can also be
   * overridden per-run via the `PORT` env var without persisting to
   * config.json — see env.ts's `apiPortOverride`.
   */
  apiPort: number;
  /** Hard per-request subprocess timeout, in ms. */
  cliTimeoutMs: number;
  /** Working directory passed to the CLIs (resolved relative to process.cwd() if not absolute). */
  cliWorkdir: string;
  /** Whether the activity log stores full prompt/response text vs. metadata only. */
  logCaptureContent: boolean;
  /** Path to persist the activity log to, or null to keep it in-memory only. */
  logFilePath: string | null;
  /**
   * When true, the spawned `codex` subprocess gets NO_PROXY/no_proxy widened
   * to also cover OpenAI's own hosts (chatgpt.com/openai.com and their
   * subdomains) — see AGENTS.md gotcha #5's "Fixing the slow start" addendum.
   * Fixes a specific, verified-live symptom: some corporate HTTP(S) proxies
   * (set via the process's own HTTPS_PROXY/https_proxy) reject codex's
   * WebSocket upgrade to `wss://chatgpt.com/...` with a `405 Method Not
   * Allowed`, and codex retries that handshake 5 times with backoff (~18-30s
   * wasted) before falling back to HTTPS on every single call. Routing
   * around the proxy for just those two host families lets the WebSocket
   * handshake succeed directly instead, cutting a request that took ~28-40s
   * down to ~6-7s in the environment this was diagnosed in.
   * Default false (opt-in), not a silent default: this only ever helps when
   * (a) a proxy is actually in play and mishandling this specific upgrade,
   * and (b) this host's network allows direct (non-proxied) egress to those
   * domains at all — on a network where only the proxy has any route out,
   * forcing a bypass would turn "slow" into "broken" instead. Only affects
   * the codex subprocess's own environment (see process/run.ts's
   * spawnManaged `env` option) — never the wrapper server's own process env,
   * and has no effect on the claude provider.
   */
  codexBypassProxyForOpenAI: boolean;
}

export interface WrapperConfig {
  version: 2;
  settings: WrapperSettings;
  models: ModelMapping[];
}

export const DEFAULT_SETTINGS: WrapperSettings = {
  apiKey: "",
  apiPort: 8869,
  cliTimeoutMs: 300_000,
  cliWorkdir: "./.cli-wrapper-workspace",
  logCaptureContent: true,
  logFilePath: null,
  codexBypassProxyForOpenAI: false,
};
