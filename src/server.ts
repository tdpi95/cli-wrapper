import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "./env.js";
import { initConfig, resolveConfigExamplePath } from "./config.js";
import { initLogPersistence } from "./logs.js";
import { buildApp } from "./app.js";

const env = loadEnv();
initConfig(env.configPath, resolveConfigExamplePath());
fs.mkdirSync(env.cliWorkdir, { recursive: true });
initLogPersistence(env.logFilePath);

const publicDir = path.resolve(import.meta.dirname, "..", "public");
const app = buildApp(env, publicDir);

app.listen(env.port, () => {
  console.log(`cli-wrapper listening on http://localhost:${env.port}`);
  console.log(`config: ${env.configPath}`);
  console.log(`cli workdir: ${env.cliWorkdir}`);
  console.log(`activity log persistence: ${env.logFilePath ?? "disabled (in-memory only)"}`);
});
