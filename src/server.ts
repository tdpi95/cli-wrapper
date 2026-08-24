import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "./env.js";
import { initConfig, resolveConfigExamplePath, getSettings } from "./config.js";
import { initLogPersistence } from "./logs.js";
import { buildApp } from "./app.js";

const env = loadEnv();
initConfig(env.configPath, resolveConfigExamplePath());
const settings = getSettings();

const cliWorkdir = path.resolve(process.cwd(), settings.cliWorkdir);
fs.mkdirSync(cliWorkdir, { recursive: true });

const logFilePath = settings.logFilePath ? path.resolve(process.cwd(), settings.logFilePath) : undefined;
initLogPersistence(logFilePath);

const publicDir = path.resolve(import.meta.dirname, "..", "public");
const app = buildApp(publicDir);

const port = env.portOverride ?? settings.port;
app.listen(port, () => {
  console.log(`cli-wrapper listening on http://localhost:${port}`);
  console.log(`config: ${env.configPath}`);
  console.log(`cli workdir: ${cliWorkdir}`);
  console.log(`activity log persistence: ${logFilePath ?? "disabled (in-memory only)"}`);
  console.log(`settings (no auth required): http://localhost:${port}/settings`);
});
