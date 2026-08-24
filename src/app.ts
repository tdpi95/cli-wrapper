import express from "express";
import { bearerAuth } from "./auth.js";
import { getSettings } from "./config.js";
import { chatRouter } from "./routes/chat.js";
import { modelsRouter } from "./routes/models.js";
import { settingsRouter } from "./routes/settings.js";

export function buildApp(publicDir: string) {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

  // Auth middleware is scoped by URL path prefix here, at the app level, so
  // Express's own routing decides which requests reach the auth check
  // before any router-internal logic runs (see AGENTS.md's gotcha #2 —
  // `app.use(mw, router)` would NOT achieve this: that form runs `mw` for
  // every request reaching this mount point regardless of whether the
  // router has a matching route).
  //
  // Only /v1/* is guarded. /settings and /api/settings/* are intentionally
  // open — no token, by design (this is the "allow open settings without
  // authentication" request) — so the settings page itself can be reached
  // without knowing the key stored inside it. That's a real trade-off: it
  // means the model routing, activity log (which can hold full prompt/
  // response text, see logs.ts), and the /v1 API key itself are all
  // readable/editable by anyone who can reach this HTTP server. Treat
  // network access to this server as equivalent to full admin access — put
  // it behind localhost-only binding, a private network, or a reverse
  // proxy with its own auth if it's ever reachable beyond a trusted host.
  app.use("/v1", bearerAuth(() => getSettings().apiKey));

  app.use(chatRouter());
  app.use(modelsRouter());
  app.use(settingsRouter(publicDir));

  return app;
}
