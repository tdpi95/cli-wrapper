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
}

/**
 * Everything that used to live in env vars, now editable at runtime from the
 * settings page (GET/PUT /api/settings/config) instead of requiring a
 * restart with different env vars. Only `PORT`/`CONFIG_PATH` remain
 * env-only — see env.ts for why (bootstrap values needed before config.json
 * can even be located/read).
 */
export interface WrapperSettings {
  /**
   * Shared bearer token required for `/v1/*`. An empty string disables auth
   * on those routes entirely — an explicit, visible opt-out (never the
   * silent default; see config.ts's auto-generation on first run).
   */
  apiKey: string;
  /** HTTP port. Only takes effect on the next restart (the server is already listening by the time this can be read). */
  port: number;
  /** Hard per-request subprocess timeout, in ms. */
  cliTimeoutMs: number;
  /** Working directory passed to the CLIs (resolved relative to process.cwd() if not absolute). */
  cliWorkdir: string;
  /** Whether the activity log stores full prompt/response text vs. metadata only. */
  logCaptureContent: boolean;
  /** Path to persist the activity log to, or null to keep it in-memory only. */
  logFilePath: string | null;
}

export interface WrapperConfig {
  version: 2;
  settings: WrapperSettings;
  models: ModelMapping[];
}

export const DEFAULT_SETTINGS: WrapperSettings = {
  apiKey: "",
  port: 8868,
  cliTimeoutMs: 120_000,
  cliWorkdir: "./.cli-wrapper-workspace",
  logCaptureContent: true,
  logFilePath: null,
};
