import { getSettings } from "../config.js";

// See AGENTS.md gotcha #5's "Fixing the slow start" addendum and
// WrapperSettings.codexBypassProxyForOpenAI's doc comment for the full
// investigation. Only these two host families are ever added — the ones
// verified to be codex's own WebSocket/HTTPS endpoints (chatgpt.com for
// ChatGPT-plan auth, openai.com for API-key auth, not re-verified here).
//
// Shared by providers/codex.ts (the legacy one-shot `codex exec` spawn) and
// process/codexAppServer.ts (the warm `codex app-server` daemon pool) — both
// spawn a `codex` subprocess that can hit the same websocket-fallback
// symptom, so both need this env override. Lives in process/, not
// providers/, to keep the dependency direction consistent with the rest of
// this codebase (process/* never imports from providers/*).
const PROXY_BYPASS_HOSTS = ["chatgpt.com", ".chatgpt.com", "openai.com", ".openai.com"];

/**
 * Builds an env override that widens NO_PROXY/no_proxy to also cover
 * codex's own hosts, merged onto (never replacing) whatever the operator's
 * environment already has there — an existing bypass list (internal hosts,
 * etc.) must survive. Read fresh per call, same "settings read live" convention
 * as everywhere else in this codebase, so flipping the setting on /settings
 * takes effect on the very next spawn with no restart.
 */
export function codexProxyBypassEnv(): Record<string, string> | undefined {
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
