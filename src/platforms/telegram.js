import path from "node:path";
import { Buffer } from "node:buffer";
import { fetch as undiciFetch } from "undici";

import { isRetriableNetworkError, requestJson } from "../utils/http.js";
import { getTelegramProxyPool } from "../utils/telegramProxy.js";

function normalizeApiBaseUrl(rawValue) {
  if (!rawValue) {
    return "https://api.telegram.org";
  }

  return rawValue.trim().replace(/\/+$/u, "");
}

function readPositiveIntegerFromEnv(name, fallbackValue) {
  const rawValue = process.env[name];
  if (rawValue == null || rawValue === "") {
    return fallbackValue;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallbackValue;
  }

  return parsed;
}

function guessMimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    default:
      return "application/octet-stream";
  }
}

function detectImageMimeType(buffer) {
  if (!buffer || buffer.length < 4) {
    return "";
  }

  if (
    buffer[0] === 0xFF &&
    buffer[1] === 0xD8 &&
    buffer[2] === 0xFF
  ) {
    return "image/jpeg";
  }

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4E &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0D &&
    buffer[5] === 0x0A &&
    buffer[6] === 0x1A &&
    buffer[7] === 0x0A
  ) {
    return "image/png";
  }

  if (
    buffer.length >= 6 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return "image/gif";
  }

  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }

  if (
    buffer[0] === 0x42 &&
    buffer[1] === 0x4D
  ) {
    return "image/bmp";
  }

  return "";
}

export class TelegramClient {
  constructor(token) {
    this.token = token;
    const baseUrl = normalizeApiBaseUrl(process.env.TELEGRAM_API_BASE_URL);
    this.apiBaseUrl = `${baseUrl}/bot${token}`;
    this.fileBaseUrl = `${baseUrl}/file/bot${token}`;
    this.proxyPool = getTelegramProxyPool();
    this.checkTimeoutMs = readPositiveIntegerFromEnv(
      "TELEGRAM_CHECK_TIMEOUT_MS",
      25_000,
    );
    this.checkRetries = readPositiveIntegerFromEnv("TELEGRAM_CHECK_RETRIES", 1);
    this.checkRetryDelayMs = readPositiveIntegerFromEnv(
      "TELEGRAM_CHECK_RETRY_DELAY_MS",
      300,
    );
  }

  async getMe() {
    return this.#call(
      "getMe",
      {},
      {
        timeoutMs: this.checkTimeoutMs,
        retries: this.checkRetries,
        retryDelayMs: this.checkRetryDelayMs,
      },
    );
  }

  async deleteWebhook() {
    return this.#call("deleteWebhook", {
      drop_pending_updates: false,
    });
  }

  async getUpdates(offset, timeoutSeconds) {
    return this.#call("getUpdates", {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: JSON.stringify(["channel_post"]),
    }, { timeoutMs: (timeoutSeconds + 10) * 1_000 });
  }

  async downloadPhoto(fileId) {
    const file = await this.#call("getFile", { file_id: fileId });
    const response = await this.#runWithProxyFailover(
      (dispatcher) => {
        const fetchOptions = {
          signal: AbortSignal.timeout(60_000),
        };

        if (dispatcher) {
          fetchOptions.dispatcher = dispatcher;
        }

        return undiciFetch(
          `${this.fileBaseUrl}/${file.file_path}`,
          fetchOptions,
        );
      },
      `Telegram file download ${file.file_path}`,
    );

    if (!response.ok) {
      throw new Error(
        `Telegram file download failed with status ${response.status} for ${file.file_path}.`,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const headerMimeType = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const pathMimeType = guessMimeType(file.file_path);
    const detectedMimeType = detectImageMimeType(buffer);

    if (!detectedMimeType) {
      throw new Error(
        `Telegram file content for ${file.file_path} is not a recognized image payload (size=${buffer.length}, header content-type=${headerMimeType || "unknown"}).`,
      );
    }

    if (file.file_size && Number.isInteger(file.file_size) && file.file_size !== buffer.length) {
      throw new Error(
        `Telegram file size mismatch for ${file.file_path}: expected ${file.file_size}, got ${buffer.length}.`,
      );
    }

    return {
      kind: "photo",
      filename: path.basename(file.file_path),
      mimeType:
        detectedMimeType ||
        (pathMimeType !== "application/octet-stream"
          ? pathMimeType
          : headerMimeType || "image/jpeg"),
      buffer,
      telegramFilePath: file.file_path,
    };
  }

  async hydratePost(post) {
    if (!post.photos.length) {
      return {
        ...post,
        media: [],
      };
    }

    const media = [];

    for (const photo of post.photos) {
      media.push(await this.downloadPhoto(photo.telegramFileId));
    }

    return {
      ...post,
      media,
    };
  }

  async #call(
    method,
    params = {},
    { timeoutMs = 30_000, retries, retryDelayMs } = {},
  ) {
    const response = await this.#runWithProxyFailover(
      (dispatcher) =>
        requestJson(`${this.apiBaseUrl}/${method}`, {
          method: "GET",
          query: params,
          timeoutMs,
          retries,
          retryDelayMs,
          dispatcher,
        }),
      `Telegram API ${method}`,
    );

    if (!response.ok) {
      throw new Error(`Telegram API error in ${method}: ${response.description}`);
    }

    return response.result;
  }

  async #runWithProxyFailover(executeRequest, contextLabel) {
    const attempts = this.proxyPool.getAttempts();
    let lastError = null;

    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index];
      const isLastAttempt = index === attempts.length - 1;

      try {
        const result = await executeRequest(attempt.dispatcher);
        this.proxyPool.markSuccess(attempt.candidateIndex);
        return result;
      } catch (error) {
        lastError = error;
        const usedProxy = attempt.candidateIndex >= 0;
        const shouldTryNext =
          !isLastAttempt &&
          (usedProxy || isRetriableNetworkError(error));

        if (shouldTryNext) {
          continue;
        }

        throw error;
      }
    }

    if (lastError) {
      const routeChain = attempts.map((attempt) => attempt.label).join(" -> ");
      const wrapped = new Error(
        `${contextLabel} failed on all routes (${routeChain}): ${lastError.message}`,
      );
      wrapped.cause = lastError;
      throw wrapped;
    }

    throw new Error(`${contextLabel} failed: no routes available.`);
  }
}
