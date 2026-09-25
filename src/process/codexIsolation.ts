// Config overrides that strip a codex turn down to what a chat completion
// needs: the model, plus codex's own read-only shell/patch tools (which
// `--sandbox read-only` already confines). See AGENTS.md gotcha #8 for the
// full investigation.
//
// Why this exists: `codex` loads the operator's own `~/.codex` setup into
// every run — plugins, skills, MCP servers, connected ChatGPT apps, hooks —
// and codex-cli 0.157.0 also turns on a default web tool, image generation,
// goals and more on its own. Verified live: a wrapper-style `codex exec`
// could call the operator's Gmail/GitHub/Slack/Drive connectors (via the
// `codex_apps` MCP server), a computer-use JS REPL (from a user-configured
// MCP server), and a `web__run` web tool even on mappings without
// enableWebSearch; it also read and followed a plugin's SKILL.md to handle a
// PDF. Same class of leak as gotcha #6 (project AGENTS.md/CLAUDE.md), just
// through the CLI's user-level config instead of the working directory.
//
// Why a list of overrides and not `--ignore-user-config`: that flag exists
// only on `codex exec`, not `codex app-server`, and on exec it still left
// connected apps, sub-agents, bundled skills and ~/.codex/skills in place
// (verified live). Pointing CODEX_HOME at a wrapper-owned dir would strip
// everything, but codex rewrites auth.json when it refreshes its login, so a
// separate copy could leave the operator's own codex logged out. Not worth it.
//
// Every key below was checked against codex-cli 0.157.0: none triggers
// codex's "ignoring unrecognized configuration setting" warning, and the
// model's own list of callable tools came back with only the plain
// shell/patch set. A future codex release can add new default-on features
// this list doesn't know about — re-run that check (AGENTS.md gotcha #8 says
// how) after upgrading codex.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type TomlValue = boolean | number | string;

const ISOLATION_OVERRIDES: Record<string, TomlValue> = {
  // Without this, codex auto-discovers and injects the nearest AGENTS.md up
  // the directory tree into its context — see AGENTS.md gotcha #6.
  project_doc_max_bytes: 0,
  // Connected ChatGPT apps (Gmail, GitHub, Slack, Drive, ...) via the
  // `codex_apps` MCP server.
  "features.apps": false,
  // Installed plugins (and every MCP server/skill/hook they bring along).
  "features.plugins": false,
  "features.remote_plugin": false,
  // Bundled skills plus ~/.codex/skills — the skill list is dropped from
  // the model's instructions entirely, so none can be discovered or read.
  "skills.bundled.enabled": false,
  "skills.include_instructions": false,
  "features.skill_search": false,
  "features.hooks": false,
  "features.computer_use": false,
  "features.browser_use": false,
  "features.in_app_browser": false,
  "features.image_generation": false,
  "features.goals": false,
  "features.tool_suggest": false,
  // Sub-agent tools can't be removed (codex requires max_threads >= 1), and
  // on ephemeral threads spawning already fails ("no thread with id") —
  // verified live. Capping at 1 (just the main agent) keeps them inert even
  // if that changes.
  "features.multi_agent": false,
  "agents.max_threads": 1,
};

/**
 * MCP servers the operator defined in codex's own config.toml, so each can be
 * turned off by name. `-c mcp_servers={}` doesn't work for this: codex merges
 * it into the existing table instead of replacing it, and the servers still
 * start (verified live: a configured `node_repl` MCP server kept running under
 * every daemon until `mcp_servers.node_repl.enabled=false` was passed). Read
 * fresh on every call, same as config.json, so a server added later is
 * covered on the very next request.
 *
 * A deliberately small scan instead of a TOML parser: it picks up the server
 * name from `[mcp_servers.<name>...]` table headers and top-level
 * `mcp_servers.<name>.key = ...` dotted keys, the usual ways a server is
 * written. It misses a server defined as an inline table
 * (`mcp_servers = { x = {...} }`) or in a profile.
 */
function userMcpServerNames(): string[] {
  const configPath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch {
    return []; // no config.toml — nothing configured to turn off
  }
  const names = new Set<string>();
  const key = String.raw`("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)`;
  const header = new RegExp(String.raw`^\s*\[\s*mcp_servers\s*\.\s*${key}`, "gm");
  const dotted = new RegExp(String.raw`^\s*mcp_servers\s*\.\s*${key}\s*\.`, "gm");
  for (const re of [header, dotted]) {
    for (const m of text.matchAll(re)) names.add(m[1].replace(/^["']|["']$/g, ""));
  }
  return [...names];
}

/** Everything to override for one turn: the static list, codex's web_search mode, and each configured MCP server off. */
function overridesFor(enableWebSearch: boolean | undefined): Record<string, TomlValue> {
  const all: Record<string, TomlValue> = { ...ISOLATION_OVERRIDES, web_search: webSearchMode(enableWebSearch) };
  for (const name of userMcpServerNames()) {
    // `-c` takes a plain dotted path, so a name that isn't a bare TOML key
    // (spaces, dots, quotes) can't be addressed there. Such a name is
    // skipped rather than risk a malformed override.
    if (/^[A-Za-z0-9_-]+$/.test(name)) all[`mcp_servers.${name}.enabled`] = false;
  }
  return all;
}

/**
 * codex's top-level `web_search` mode. It takes precedence over the older
 * `tools.web_search = true` (verified live: `web_search = "disabled"` plus
 * `tools.web_search = true` has no web tool), so it's the one switch for
 * ModelMapping.enableWebSearch. Without it, 0.157.0 defaults to a web tool
 * being available on every turn.
 */
function webSearchMode(enableWebSearch: boolean | undefined): string {
  return enableWebSearch ? "live" : "disabled";
}

function tomlLiteral(value: TomlValue): string {
  // JSON string escaping is valid TOML basic-string syntax for these values.
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/** As `-c key=value` argv pairs, for `codex exec` and the `codex app-server` daemon spawn. */
export function codexIsolationArgs(enableWebSearch: boolean | undefined): string[] {
  return Object.entries(overridesFor(enableWebSearch)).flatMap(([key, value]) => ["-c", `${key}=${tomlLiteral(value)}`]);
}

/** As a nested object, for app-server `thread/start`'s `config` (same shape `-c` dotted keys expand to). */
export function codexIsolationConfig(enableWebSearch: boolean | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overridesFor(enableWebSearch))) {
    const parts = key.split(".");
    let node = out;
    for (const part of parts.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>;
    node[parts[parts.length - 1]] = value;
  }
  return out;
}
