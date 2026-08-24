import { Router } from "express";
import { loadConfig } from "../config.js";

// See the comment in chat.ts: auth is applied by path prefix in app.ts, not here.
export function modelsRouter(): Router {
  const router = Router();

  router.get("/v1/models", (_req, res) => {
    const cfg = loadConfig();
    res.json({
      object: "list",
      data: cfg.models.map((m) => ({
        id: m.id,
        object: "model",
        created: 0,
        owned_by: m.provider,
      })),
    });
  });

  return router;
}
