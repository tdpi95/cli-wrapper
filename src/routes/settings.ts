import path from "node:path";
import { Router } from "express";
import { addMapping, deleteMapping, getSettings, loadConfig, updateMapping, updateSettings } from "../config.js";
import { toApiError } from "../errors.js";
import { clearLogEntries, getLogEntries, getLogPersistPath, isLogPersistenceEnabled, setLogPersistPath } from "../logs.js";
import { getPoolStatus } from "../process/claudePool.js";

// No auth on any route in this file, by design — see the note in app.ts.
export function settingsRouter(publicDir: string): Router {
  const router = Router();

  router.get("/settings", (_req, res) => {
    res.sendFile(path.join(publicDir, "settings.html"));
  });

  // Kept for backwards compatibility with the settings page's previous
  // shape; /api/settings/config below is the full read/write surface.
  router.get("/api/settings/meta", (_req, res) => {
    const settings = getSettings();
    res.json({
      logCaptureContent: settings.logCaptureContent,
      logPersistence: { enabled: isLogPersistenceEnabled(), path: getLogPersistPath() },
    });
  });

  router.get("/api/settings/config", (_req, res) => {
    res.json(getSettings());
  });

  router.put("/api/settings/config", (req, res) => {
    try {
      const before = getSettings();
      const updated = updateSettings(req.body);
      if (updated.logFilePath !== before.logFilePath) {
        setLogPersistPath(updated.logFilePath ? path.resolve(process.cwd(), updated.logFilePath) : undefined);
      }
      res.json(updated);
    } catch (err) {
      const { status, body } = toApiError(err);
      res.status(status).json(body);
    }
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

  // claude only — codex has no persistent pool to report on (a fresh `codex
  // exec` is spawned per request; see AGENTS.md's "Warm claude process pool").
  router.get("/api/settings/pool-status", (_req, res) => {
    res.json(getPoolStatus());
  });

  return router;
}
