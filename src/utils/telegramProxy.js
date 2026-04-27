import { ProxyAgent } from "undici";

import { log, warn } from "./logger.js";

const SUPPORTED_PROXY_PROTOCOLS = new Set([
  "http:",
  "https:",
  "socks:",
  "socks5:",
]);
const NUMBERED_PROXY_ENV_PATTERN = /^TELEGRAM_PROXY_(\d+)$/u;
let cachedTelegramProxyPool = null;

function toBoolean(rawValue, defaultValue) {
  if (rawValue == null || rawValue === "") {
    return defaultValue;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function toInteger(rawValue, defaultValue) {
  if (rawValue == null || rawValue === "") {
    return defaultValue;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return defaultValue;
  }

  return parsed;
}

function splitProxyList(rawValue) {
  if (!rawValue) {
    return [];
  }

  return rawValue
    .split(/[\r\n,;]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function readProxyEntriesFromEnv() {
  const numberedEntries = Object.entries(process.env)
    .map(([name, value]) => {
      const match = name.match(NUMBERED_PROXY_ENV_PATTERN);
      if (!match || !value) {
        return null;
      }

      return {
        value: String(value).trim(),
        order: Number.parseInt(match[1], 10),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.value);

  const poolEntries = splitProxyList(process.env.TELEGRAM_PROXY_POOL ?? "");
  const singleEntry = process.env.TELEGRAM_PROXY_URL
    ? [process.env.TELEGRAM_PROXY_URL.trim()]
    : [];

  return [...numberedEntries, ...poolEntries, ...singleEntry];
}

function buildDisplayUrl(url) {
  const hostPort = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  return `${url.protocol}//${hostPort}`;
}

function parseTgSocksProxy(rawValue) {
  const target = new URL(rawValue);
  const server = (target.searchParams.get("server") ?? "").trim();
  const port = (target.searchParams.get("port") ?? "").trim();
  const username = target.searchParams.get("user") ?? "";
  const password = target.searchParams.get("pass") ?? "";

  if (!server || !port) {
    return {
      skipped: true,
      reason: "missing server/port in tg://socks entry",
    };
  }

  const authPart = username
    ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
    : "";
  const proxyUrl = `socks5://${authPart}${server}:${port}`;
  const parsedProxy = new URL(proxyUrl);

  return {
    proxyUrl,
    displayUrl: buildDisplayUrl(parsedProxy),
  };
}

function parseProxyEntry(rawValue) {
  if (rawValue.startsWith("tg://socks?")) {
    return parseTgSocksProxy(rawValue);
  }

  if (rawValue.startsWith("tg://proxy?")) {
    return {
      skipped: true,
      reason:
        "tg://proxy (MTProto) cannot be used for Telegram Bot API HTTPS calls",
    };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawValue);
  } catch {
    return {
      skipped: true,
      reason: "invalid proxy URL format",
    };
  }

  if (!SUPPORTED_PROXY_PROTOCOLS.has(parsedUrl.protocol)) {
    return {
      skipped: true,
      reason: `unsupported proxy protocol "${parsedUrl.protocol}"`,
    };
  }

  return {
    proxyUrl: parsedUrl.toString(),
    displayUrl: buildDisplayUrl(parsedUrl),
  };
}

export class TelegramProxyPool {
  constructor(entries, { allowDirectFallback = true, connectTimeoutMs = 10_000 } = {}) {
    this.allowDirectFallback = allowDirectFallback;
    this.entries = entries.map((entry) => ({
      ...entry,
      dispatcher: new ProxyAgent({
        uri: entry.proxyUrl,
        connectTimeout: connectTimeoutMs,
      }),
    }));
    this.activeIndex = 0;
  }

  getAttempts() {
    const attempts = [];
    const total = this.entries.length;

    for (let offset = 0; offset < total; offset += 1) {
      const index = (this.activeIndex + offset) % total;
      const entry = this.entries[index];
      attempts.push({
        candidateIndex: index,
        dispatcher: entry.dispatcher,
        label: entry.displayUrl,
      });
    }

    if (this.allowDirectFallback || attempts.length === 0) {
      attempts.push({
        candidateIndex: -1,
        dispatcher: null,
        label: "direct",
      });
    }

    return attempts;
  }

  markSuccess(candidateIndex) {
    if (candidateIndex < 0 || candidateIndex >= this.entries.length) {
      return;
    }

    this.activeIndex = candidateIndex;
  }
}

export function getTelegramProxyPool() {
  if (cachedTelegramProxyPool) {
    return cachedTelegramProxyPool;
  }

  const rawEntries = readProxyEntriesFromEnv();
  const parsedEntries = [];

  rawEntries.forEach((rawValue, index) => {
    const parsed = parseProxyEntry(rawValue);

    if (parsed.skipped) {
      warn(`[telegram-proxy] Entry #${index + 1} skipped: ${parsed.reason}.`);
      return;
    }

    parsedEntries.push({
      ...parsed,
      rawValue,
    });
  });

  const allowDirectFallback = toBoolean(
    process.env.TELEGRAM_PROXY_DIRECT_FALLBACK,
    true,
  );
  const connectTimeoutMs = toInteger(
    process.env.TELEGRAM_PROXY_CONNECT_TIMEOUT_MS,
    10_000,
  );

  if (parsedEntries.length > 0) {
    log(
      `[telegram-proxy] Loaded ${parsedEntries.length} usable proxies. Current priority starts with ${parsedEntries[0].displayUrl}.`,
    );
  } else if (rawEntries.length > 0) {
    warn(
      "[telegram-proxy] Proxy list was provided, but no usable SOCKS/HTTP proxy was found. Falling back to direct connection.",
    );
  }

  cachedTelegramProxyPool = new TelegramProxyPool(parsedEntries, {
    allowDirectFallback,
    connectTimeoutMs,
  });

  return cachedTelegramProxyPool;
}
