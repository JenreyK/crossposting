import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function stripWrappingQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

export function loadDotEnv(filePath = path.resolve(process.cwd(), ".env")) {
  if (!existsSync(filePath)) {
    return;
  }

  const text = readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/u);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = stripWrappingQuotes(line.slice(separatorIndex + 1).trim());

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function getString(name, { required = false, defaultValue = "" } = {}) {
  const value = process.env[name];

  if (value == null || value === "") {
    if (required) {
      throw new Error(`Environment variable ${name} is required.`);
    }

    return defaultValue;
  }

  return value;
}

function getInteger(name, { required = false, defaultValue } = {}) {
  const rawValue = process.env[name];

  if (rawValue == null || rawValue === "") {
    if (required) {
      throw new Error(`Environment variable ${name} is required.`);
    }

    return defaultValue;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer.`);
  }

  return parsed;
}

function getOptionalInteger(name) {
  const rawValue = process.env[name];

  if (rawValue == null || rawValue === "") {
    return null;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer.`);
  }

  return parsed;
}

function normalizeChatUsername(value) {
  return value.replace(/^@/u, "").trim();
}

function parseCsv(rawValue) {
  return rawValue
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function sanitizeProfileName(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-");
}

function profileEnvName(profileName, key) {
  return `${profileName.toUpperCase()}_${key}`;
}

function readProfileValue(profileName, key, fallbackKey = null) {
  const profileValue = getString(profileEnvName(profileName, key));
  if (profileValue) {
    return profileValue;
  }

  if (fallbackKey) {
    return getString(fallbackKey);
  }

  return "";
}

function readProfileInteger(profileName, key, fallbackKey = null) {
  const profileKey = profileEnvName(profileName, key);
  const profileValue = process.env[profileKey];

  if (profileValue != null && profileValue !== "") {
    const parsed = Number.parseInt(profileValue, 10);
    if (Number.isNaN(parsed)) {
      throw new Error(`Environment variable ${profileKey} must be an integer.`);
    }

    return parsed;
  }

  if (fallbackKey) {
    return getOptionalInteger(fallbackKey);
  }

  return null;
}

function buildTokenStateKey(token) {
  return createHash("sha1").update(token).digest("hex").slice(0, 12);
}

function readProfileConfig(
  profileName,
  { command, telegramDefaults, maxDefaults, legacyMode },
) {
  const sourceChatIdFallback = legacyMode ? "TELEGRAM_SOURCE_CHAT_ID" : null;
  const sourceChatUsernameFallback = legacyMode
    ? "TELEGRAM_SOURCE_CHAT_USERNAME"
    : null;
  const vkAccessTokenFallback = legacyMode ? "VK_ACCESS_TOKEN" : null;
  const vkGroupIdFallback = legacyMode ? "VK_GROUP_ID" : null;
  const maxAccessTokenFallback = legacyMode ? "MAX_ACCESS_TOKEN" : null;
  const maxChatIdFallback = legacyMode ? "MAX_CHAT_ID" : null;
  const postPrefixFallback = legacyMode ? "POST_PREFIX" : null;
  const processedStateFileFallback = legacyMode ? "STATE_FILE" : null;
  const telegramToken = readProfileValue(
    profileName,
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_BOT_TOKEN",
  );
  const sourceChatId = readProfileValue(
    profileName,
    "TELEGRAM_SOURCE_CHAT_ID",
    sourceChatIdFallback,
  );
  const sourceChatUsername = readProfileValue(
    profileName,
    "TELEGRAM_SOURCE_CHAT_USERNAME",
    sourceChatUsernameFallback,
  );
  const vkAccessToken = readProfileValue(
    profileName,
    "VK_ACCESS_TOKEN",
    vkAccessTokenFallback,
  );
  const vkMediaAccessToken = readProfileValue(
    profileName,
    "VK_MEDIA_ACCESS_TOKEN",
    null,
  );
  const vkGroupId = readProfileInteger(
    profileName,
    "VK_GROUP_ID",
    vkGroupIdFallback,
  );
  const maxAccessToken = readProfileValue(
    profileName,
    "MAX_ACCESS_TOKEN",
    maxAccessTokenFallback,
  );
  const maxChatId = readProfileInteger(
    profileName,
    "MAX_CHAT_ID",
    maxChatIdFallback,
  );
  const hasVk = Boolean(vkAccessToken && vkGroupId);
  const hasMax = Boolean(maxAccessToken && maxChatId);
  const hasAnyTargetCredential = Boolean(vkAccessToken || maxAccessToken);

  if (vkAccessToken && /^[a-f0-9]{16,40}$/u.test(vkAccessToken)) {
    throw new Error(
      `Profile "${profileName}" has ${profileEnvName(profileName, "VK_ACCESS_TOKEN")} that looks like a secure key, not an access token. Use a real VK access token (usually much longer).`,
    );
  }

  if (vkMediaAccessToken && /^[a-f0-9]{16,40}$/u.test(vkMediaAccessToken)) {
    throw new Error(
      `Profile "${profileName}" has ${profileEnvName(profileName, "VK_MEDIA_ACCESS_TOKEN")} that looks like a secure key, not an access token. Use a real user access token for media upload.`,
    );
  }

  if (command !== "max:chats" && !telegramToken) {
    throw new Error(
      `Profile "${profileName}" requires ${profileEnvName(profileName, "TELEGRAM_BOT_TOKEN")} or TELEGRAM_BOT_TOKEN.`,
    );
  }

  if (command !== "max:chats" && !sourceChatId && !sourceChatUsername) {
    throw new Error(
      `Profile "${profileName}" requires ${profileEnvName(profileName, "TELEGRAM_SOURCE_CHAT_ID")} or ${profileEnvName(profileName, "TELEGRAM_SOURCE_CHAT_USERNAME")}.`,
    );
  }

  if (command === "start" && !hasVk && !hasMax) {
    throw new Error(
      `Profile "${profileName}" must have at least one target: VK or MAX.`,
    );
  }

  if (command === "check" && !hasAnyTargetCredential) {
    throw new Error(
      `Profile "${profileName}" must have at least one configured target token for check.`,
    );
  }

  if (command === "max:chats" && !maxAccessToken) {
    return null;
  }

  return {
    name: sanitizeProfileName(profileName),
    label:
      readProfileValue(profileName, "NAME") || sanitizeProfileName(profileName),
    postPrefix: readProfileValue(profileName, "POST_PREFIX", postPrefixFallback),
    processedStateFile: path.resolve(
      process.cwd(),
      readProfileValue(
        profileName,
        "PROCESSED_STATE_FILE",
        processedStateFileFallback,
      ) || `.runtime/${sanitizeProfileName(profileName)}.processed.json`,
    ),
    telegram: {
      token: telegramToken,
      tokenStateKey: buildTokenStateKey(telegramToken),
      sourceChatId,
      sourceChatUsername: sourceChatUsername
        ? normalizeChatUsername(sourceChatUsername)
        : "",
      pollTimeoutSeconds: telegramDefaults.pollTimeoutSeconds,
      mediaGroupDelayMs: telegramDefaults.mediaGroupDelayMs,
    },
    vk: vkAccessToken
      ? {
          accessToken: vkAccessToken,
          mediaAccessToken: vkMediaAccessToken || null,
          groupId: vkGroupId,
          apiVersion:
            readProfileValue(profileName, "VK_API_VERSION", "VK_API_VERSION") ||
            "5.199",
        }
      : null,
    max: maxAccessToken
      ? {
          accessToken: maxAccessToken,
          chatId: maxChatId,
          attachmentReadyRetries: readProfileInteger(
            profileName,
            "MAX_ATTACHMENT_READY_RETRIES",
            "MAX_ATTACHMENT_READY_RETRIES",
          ) ?? maxDefaults.attachmentReadyRetries,
          attachmentReadyDelayMs: readProfileInteger(
            profileName,
            "MAX_ATTACHMENT_READY_DELAY_MS",
            "MAX_ATTACHMENT_READY_DELAY_MS",
          ) ?? maxDefaults.attachmentReadyDelayMs,
        }
      : null,
  };
}

function readProfileNames() {
  const rawProfiles = getString("APP_PROFILES");

  if (!rawProfiles) {
    return ["default"];
  }

  const names = parseCsv(rawProfiles);
  if (names.length === 0) {
    throw new Error("APP_PROFILES must contain at least one profile name.");
  }

  return names;
}

export function readConfig({ command = "start" } = {}) {
  const legacyMode = !getString("APP_PROFILES");
  const telegramDefaults = {
    pollTimeoutSeconds: getInteger("TELEGRAM_POLL_TIMEOUT_SECONDS", {
      defaultValue: 30,
    }),
    mediaGroupDelayMs: getInteger("TELEGRAM_MEDIA_GROUP_DELAY_MS", {
      defaultValue: 2500,
    }),
  };
  const maxDefaults = {
    attachmentReadyRetries: getInteger("MAX_ATTACHMENT_READY_RETRIES", {
      defaultValue: 5,
    }),
    attachmentReadyDelayMs: getInteger("MAX_ATTACHMENT_READY_DELAY_MS", {
      defaultValue: 1200,
    }),
  };
  const profiles = readProfileNames()
    .map((profileName) =>
      readProfileConfig(profileName, {
        command,
        telegramDefaults,
        maxDefaults,
        legacyMode,
      }),
    )
    .filter(Boolean);

  if (profiles.length === 0) {
    throw new Error("No usable profiles found in configuration.");
  }

  return {
    offsetsStateFile: path.resolve(
      process.cwd(),
      getString("OFFSETS_STATE_FILE", {
        defaultValue: ".runtime/offsets.json",
      }),
    ),
    profiles,
  };
}
