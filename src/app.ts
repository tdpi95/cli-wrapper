import express from "express";
import { bearerAuth } from "./auth.js";
import { getSettings } from "./config.js";
import { chatRouter } from "./routes/chat.js";
import { modelsRouter } from "./routes/models.js";
import { settingsRouter } from "./routes/settings.js";

// Two separate express apps, bound to two separate ports by server.ts — not
// one app with path-scoped auth like before. See AGENTS.md's "Two ports, by
// design" section for the full rationale; short version: path-scoped auth
// (still applied below, on /v1) only helps if every request actually goes
// through this process's routing at all. Putting the unauthenticated
// settings surface on its own port means it can be bound to localhost/a
// private interface (or simply not exposed past a firewall) independent of
// wherever the API port is reachable, so exposing the API to more of the
// network can no longer accidentally expose settings as a side effect of
// sharing one port.

/**
 * The OpenAI-compatible API surface: `/v1/chat/completions`, `/v1/models`.
 * The only surface with auth (`bearerAuth`, scoped to `/v1` — see AGENTS.md's
 * gotcha #2 for why this is `app.use(path, mw)`, not a router-internal
 * `router.use(mw)`).
 */
export function buildApiApp() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  app.use("/v1", bearerAuth(() => getSettings().apiKey));
  app.use(chatRouter());
  app.use(modelsRouter());
  return app;
}

/**
 * The settings surface: `/settings`, `/api/settings/*`. No auth on any route
 * here, by design — see AGENTS.md's "Settings has no auth, by design". This
 * means the model routing, activity log, and the `/v1` API key itself are
 * all readable/editable by anyone who can reach *this* port — treat network
 * access to it as equivalent to full admin access.
 */
export function buildSettingsApp(publicDir: string) {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  app.use(settingsRouter(publicDir));
  return app;
}
