import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "./env.js";
import { initConfig, resolveConfigExamplePath, getSettings } from "./config.js";
import { initLogPersistence } from "./logs.js";
import { shutdownClaudePool } from "./process/claudePool.js";
import { buildApiApp, buildSettingsApp } from "./app.js";

const env = loadEnv();
initConfig(env.configPath, resolveConfigExamplePath());
const settings = getSettings();

const cliWorkdir = path.resolve(process.cwd(), settings.cliWorkdir);
fs.mkdirSync(cliWorkdir, { recursive: true });

const logFilePath = settings.logFilePath ? path.resolve(process.cwd(), settings.logFilePath) : undefined;
initLogPersistence(logFilePath);

const publicDir = path.resolve(import.meta.dirname, "..", "public");

// Two separate listeners on two separate ports — not one app on one port —
// so the unauthenticated settings surface can be bound/firewalled
// independently of the API surface. See app.ts's top comment and AGENTS.md's
// "Two ports, by design" section.
const apiPort = env.apiPortOverride ?? settings.apiPort;
const settingsPort = env.settingsPort;

const apiApp = buildApiApp();
apiApp.listen(apiPort, () => {
  console.log(`cli-wrapper API listening on http://localhost:${apiPort}`);
});

const settingsApp = buildSettingsApp(publicDir);
settingsApp.listen(settingsPort, () => {
  console.log(`settings (no auth required): http://localhost:${settingsPort}/settings`);
});

console.log(`config: ${env.configPath}`);
console.log(`cli workdir: ${cliWorkdir}`);
console.log(`activity log persistence: ${logFilePath ?? "disabled (in-memory only)"}`);

// The claude provider now keeps warm processes running between requests
// (see process/claudePool.ts) — unlike the old one-shot-per-request design,
// those can outlive a single HTTP request, so they need an explicit exit
// hook or a killed/Ctrl-C'd server would leave them orphaned.
function shutdown(signal: NodeJS.Signals): void {
  console.log(`${signal} received, shutting down warm claude processes...`);
  shutdownClaudePool();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
