import { fetch as undiciFetch } from "undici";

export class HttpError extends Error {
  constructor(message, { status, url, body } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getNetworkErrorCode(error) {
  return (
    error?.cause?.code ??
    error?.code ??
    null
  );
}

export function isRetriableNetworkError(error) {
  const code = getNetworkErrorCode(error);
  if (!code) {
    return false;
  }

  return new Set([
    "UND_ERR_PROXY_CONNECT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENETUNREACH",
    "EHOSTUNREACH",
  ]).has(code);
}

function buildUrl(url, query = {}) {
  const target = new URL(url);

  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === "") {
      continue;
    }

    target.searchParams.set(key, String(value));
  }

  return target;
}

async function parseResponse(response) {
  const contentType = response.headers.get("content-type") ?? "";

  if (
    contentType.includes("application/json") ||
    contentType.includes("+json")
  ) {
    return response.json();
  }

  const text = await response.text();
  const trimmed = text.trim();

  // Some APIs (including VK upload endpoints) return JSON with non-JSON content-type.
  if (
    trimmed.startsWith("{") ||
    trimmed.startsWith("[")
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Keep original text fallback for non-JSON payloads.
    }
  }

  return text;
}

export async function requestJson(url, options = {}) {
  const {
    method = "GET",
    headers = {},
    query,
    json,
    form,
    body,
    dispatcher,
    timeoutMs = 30_000,
    retries = null,
    retryDelayMs = 350,
  } = options;

  const target = buildUrl(url, query);
  const upperMethod = method.toUpperCase();
  const maxAttempts = retries ?? (upperMethod === "GET" ? 5 : 1);
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const requestOptions = {
        method: upperMethod,
        headers: {
          ...headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
      };

      if (dispatcher) {
        requestOptions.dispatcher = dispatcher;
      }

      if (json != null) {
        requestOptions.headers["Content-Type"] = "application/json";
        requestOptions.body = JSON.stringify(json);
      } else if (form != null) {
        requestOptions.body = form;
      } else if (body != null) {
        requestOptions.body = body;
      }

      const response = await undiciFetch(target, requestOptions);
      const parsed = await parseResponse(response);

      if (!response.ok) {
        throw new HttpError(
          `Request failed with status ${response.status} for ${target.toString()}`,
          {
            status: response.status,
            url: target.toString(),
            body: parsed,
          },
        );
      }

      return parsed;
    } catch (error) {
      lastError = error;

      const canRetry =
        attempt < maxAttempts &&
        isRetriableNetworkError(error);

      if (!canRetry) {
        throw error;
      }

      // Lightweight exponential backoff for transient transport failures.
      await sleep(retryDelayMs * 2 ** (attempt - 1));
    }
  }

  throw lastError;
}
