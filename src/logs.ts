import crypto from "node:crypto";
import fs from "node:fs";
import type { Usage } from "./providers/types.js";

export type LogStatus = "success" | "error" | "timeout";

export interface LogEntry {
  id: string;
  timestamp: number; // epoch ms
  model: string;
  provider: "claude" | "codex" | "unknown";
  stream: boolean;
  status: LogStatus;
  durationMs: number;
  usage?: Usage;
  error?: string;
  /** The flattened system-prompt + transcript actually sent to the CLI. */
  input?: string;
  /** The full assistant response text, when the request succeeded. */
  output?: string;
}

// Capped ring buffer, always kept in memory. Persistence to disk is opt-in
// (see initLogPersistence) — with it off, this is exactly as before:
// cleared on restart, never touches disk. With it on, the same 200-entry
// buffer is written to a JSON file after every change and reloaded at
// startup, so activity (including full request/response content if
// LOG_CAPTURE_CONTENT is on — see env.ts/README) survives a restart.
// Don't enable persistence casually: it means sensitive conversation
// content can end up sitting in a plaintext file on disk, not just memory.
const MAX_ENTRIES = 200;
const entries: LogEntry[] = [];

let persistPath: string | undefined;

/** Call once at startup. Loads any existing log file; no-op if filePath is undefined. */
export function initLogPersistence(filePath: string | undefined): void {
  persistPath = filePath;
  if (!persistPath) return;

  if (fs.existsSync(persistPath)) {
    try {
      const raw = fs.readFileSync(persistPath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        entries.push(...parsed.slice(0, MAX_ENTRIES));
      } else {
        console.warn(`Log file at ${persistPath} did not contain an array; starting with an empty log.`);
      }
    } catch (err) {
      console.warn(`Failed to load log file at ${persistPath}, starting with an empty log:`, err);
    }
  }
}

function persist(): void {
  if (!persistPath) return;
  try {
    const tmpPath = `${persistPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2) + "\n", "utf8");
    fs.renameSync(tmpPath, persistPath);
  } catch (err) {
    // Persistence is best-effort: never let a disk write failure break the
    // request that triggered it.
    console.warn(`Failed to write log file at ${persistPath}:`, err);
  }
}

export function addLogEntry(entry: Omit<LogEntry, "id" | "timestamp">): void {
  entries.unshift({ id: crypto.randomUUID(), timestamp: Date.now(), ...entry });
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  persist();
}

/** Newest first. */
export function getLogEntries(): LogEntry[] {
  return entries;
}

export function clearLogEntries(): void {
  entries.length = 0;
  persist();
}

export function isLogPersistenceEnabled(): boolean {
  return persistPath !== undefined;
}

export function getLogPersistPath(): string | undefined {
  return persistPath;
}
