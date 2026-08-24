import path from "node:path";
import { Router } from "express";
import { addMapping, deleteMapping, loadConfig, updateMapping } from "../config.js";
import { toApiError } from "../errors.js";
import { clearLogEntries, getLogEntries, getLogPersistPath, isLogPersistenceEnabled } from "../logs.js";

// See the comment in chat.ts: auth is applied by path prefix in app.ts, not here.
export function settingsRouter(publicDir: string, logCaptureContent: boolean): Router {
  const router = Router();

  router.get("/settings", (_req, res) => {
    res.sendFile(path.join(publicDir, "settings.html"));
  });

  router.get("/api/settings/meta", (_req, res) => {
    res.json({
      logCaptureContent,
      logPersistence: { enabled: isLogPersistenceEnabled(), path: getLogPersistPath() },
    });
  });

  router.get("/api/settings/models", (_req, res) => {
    res.json(loadConfig().models);
  });

  router.post("/api/settings/models", (req, res) => {
    try {
      const created = addMapping(req.body);
      res.status(201).json(created);
    } catch (err) {
      const { status, body } = toApiError(err);
      res.status(status).json(body);
    }
  });

  router.put("/api/settings/models/:id", (req, res) => {
    try {
      const updated = updateMapping(req.params.id, req.body);
      res.json(updated);
    } catch (err) {
      const { status, body } = toApiError(err);
      res.status(status).json(body);
    }
  });

  router.delete("/api/settings/models/:id", (req, res) => {
    try {
      deleteMapping(req.params.id);
      res.status(204).end();
    } catch (err) {
      const { status, body } = toApiError(err);
      res.status(status).json(body);
    }
  });

  router.get("/api/settings/logs", (_req, res) => {
    res.json(getLogEntries());
  });

  router.delete("/api/settings/logs", (_req, res) => {
    clearLogEntries();
    res.status(204).end();
  });

  return router;
}
