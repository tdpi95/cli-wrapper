export class ApiError extends Error {
  status: number;
  code: string;
  type: string;

  constructor(status: number, type: string, code: string, message: string) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

export class ValidationError extends ApiError {
  constructor(message: string) {
    super(400, "invalid_request_error", "invalid_request", message);
  }
}

export class ModelNotFoundError extends ApiError {
  constructor(model: string) {
    super(404, "invalid_request_error", "model_not_found", `Unknown model: ${model}`);
  }
}

export class NotFoundError extends ApiError {
  constructor(message: string) {
    super(404, "invalid_request_error", "not_found", message);
  }
}

export class InvalidApiKeyError extends ApiError {
  constructor() {
    super(401, "invalid_request_error", "invalid_api_key", "Invalid or missing API key");
  }
}

export class TimeoutError extends ApiError {
  constructor(message: string) {
    super(504, "timeout_error", "provider_timeout", message);
  }
}

export class CliExecutionError extends ApiError {
  constructor(message: string) {
    super(502, "api_error", "provider_error", message);
  }
}

export class CliParseError extends ApiError {
  constructor(message: string) {
    super(502, "api_error", "provider_bad_response", message);
  }
}

/** Converts any thrown error into an OpenAI-shaped {status, body} pair. */
export function toApiError(err: unknown): { status: number; body: unknown } {
  if (err instanceof ApiError) {
    return {
      status: err.status,
      body: { error: { message: err.message, type: err.type, code: err.code } },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    status: 500,
    body: { error: { message, type: "api_error", code: "internal_error" } },
  };
}
