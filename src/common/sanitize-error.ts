import { isAxiosError } from "axios";

const REDACTED = "[REDACTED]";

// Errors such as AxiosError can embed the request config (headers, auth, url),
// which can carry API credentials, we redact them before the error is logged.
export const sanitizeError = (error: unknown): unknown => {
  if (!isAxiosError(error)) {
    return error;
  }

  try {
    const serialized = error.toJSON() as { config?: Record<string, unknown> };
    if (serialized.config) {
      if ("headers" in serialized.config) {
        serialized.config.headers = REDACTED;
      }
      if ("auth" in serialized.config) {
        serialized.config.auth = REDACTED;
      }
      if ("url" in serialized.config) {
        serialized.config.url = redactUrl(serialized.config.url);
      }
      if ("baseURL" in serialized.config) {
        serialized.config.baseURL = redactUrl(serialized.config.baseURL);
      }
    }
    return serialized;
  } catch {
    // No throw - this also runs inside process-level crash handlers.
    return { name: error.name, message: error.message, code: error.code };
  }
};

// Query-string parameter names that carry secrets in the URLs.
const REDACTED_QUERY_PARAMS = new Set([
  "api-key",
  "apikey",
  "api_key",
  "key",
  "access_token",
  "token",
  "dd-api-key",
]);

// Redact credentials carried in a URL while keeping scheme/host/path.
const redactUrl = (value: unknown): unknown => {
  if (typeof value !== "string") {
    return value;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Relative path or non-URL string - nothing to strip.
    return value;
  }

  let redacted = false;
  if (url.username || url.password) {
    url.username = REDACTED;
    url.password = "";
    redacted = true;
  }

  for (const key of [...url.searchParams.keys()]) {
    if (REDACTED_QUERY_PARAMS.has(key.toLowerCase())) {
      url.searchParams.set(key, REDACTED);
      redacted = true;
    }
  }

  return redacted ? url.toString() : value;
};
