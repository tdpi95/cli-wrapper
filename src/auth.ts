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
 * Bearer-token auth. Accepts the token via the standard Authorization header
 * (used by the chat API and OpenAI-style clients), and additionally via a
 * `?token=` query param — needed because a browser navigating directly to
 * /settings can't attach a custom header. The query-param fallback is scoped
 * to this middleware only being mounted on /settings and /api/settings/*.
 */
export function bearerAuth(apiKey: string, opts: { allowQueryToken?: boolean } = {}) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    let presented: string | undefined;
    if (header && header.startsWith("Bearer ")) {
      presented = header.slice("Bearer ".length);
    } else if (opts.allowQueryToken && typeof req.query.token === "string") {
      presented = req.query.token;
    }

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
