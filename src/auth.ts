import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { InvalidApiKeyError } from "./errors.js";

function safeEqual(a: string, b: string): boolean {
  // Hash both sides to a fixed length first so we never throw on length
  // mismatch and never leak length via a Buffer-length short-circuit.
  const hashA = crypto.createHash("sha256").update(a).digest();
  const hashB = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Bearer-token auth for `/v1/*`. Takes a getter rather than a fixed string
 * because the key now lives in config.json and can change at runtime via
 * the (unauthenticated) settings page — each request re-reads the current
 * value, same "always read fresh" convention as config.ts. An empty key
 * means auth is deliberately disabled: this is only ever true if someone
 * blanked it out on /settings (config.ts always generates a non-empty key
 * on first run), so treat it as an explicit, visible opt-out, not a silent
 * default.
 */
export function bearerAuth(getApiKey: () => string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const apiKey = getApiKey();
    if (!apiKey) {
      next();
      return;
    }

    const header = req.headers.authorization;
    const presented = header && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;

    if (!presented || !safeEqual(presented, apiKey)) {
      const { status, body } = toErrorResponse();
      res.status(status).json(body);
      return;
    }
    next();
  };
}

function toErrorResponse() {
  const err = new InvalidApiKeyError();
  return { status: err.status, body: { error: { message: err.message, type: err.type, code: err.code } } };
}
