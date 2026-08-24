import express from "express";
import path from "node:path";
import type { Env } from "./env.js";
import { bearerAuth } from "./auth.js";
import { chatRouter } from "./routes/chat.js";
import { modelsRouter } from "./routes/models.js";
import { settingsRouter } from "./routes/settings.js";

export function buildApp(env: Env, publicDir: string) {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  const strictAuth = bearerAuth(env.apiKey);
  const settingsAuth = bearerAuth(env.apiKey, { allowQueryToken: true });

  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

  // Auth middleware is scoped by URL path prefix here, at the app level, so
  // Express's own routing decides which requests reach which auth check
  // before any router-internal logic runs. `app.use(path, mw)` matches
  // path and everything under it (e.g. "/v1" matches "/v1/models").
  // Mounting auth via `app.use(mw, router)` instead would NOT achieve this:
  // that form runs `mw` for every request that reaches this mount point
  // ("/" for all three routers below), regardless of whether the router
  // actually has a matching route — the first such middleware in the chain
  // would hijack every request, authenticated or not.
  app.use("/v1", strictAuth);
  app.use(["/settings", "/api/settings"], settingsAuth);

  app.use(chatRouter(env));
  app.use(modelsRouter());
  app.use(settingsRouter(publicDir, env.logCaptureContent));

  return app;
}
