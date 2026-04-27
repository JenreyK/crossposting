import dns from "node:dns";
import path from "node:path";

import { CrossposterApp, createProfileRuntime } from "./app.js";
import { MaxPublisher } from "./platforms/max.js";
import { TelegramClient } from "./platforms/telegram.js";
import { VkPublisher } from "./platforms/vk.js";
import { OffsetStore, ProcessedStore } from "./state/store.js";
import { loadDotEnv, readConfig } from "./utils/env.js";
import { log, warn } from "./utils/logger.js";

// On some networks IPv6 paths to Telegram/VK endpoints are flaky.
// Prefer IPv4 to avoid UND_ERR_CONNECT_TIMEOUT in Node fetch.
dns.setDefaultResultOrder(process.env.DNS_RESULT_ORDER || "ipv4first");

function parseCliArgs(argv) {
  const options = {
    command: "start",
    envFile: "",
    profileFilter: "",
  };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--env" || argument === "--env-file") {
      const value = argv[index + 1] ?? "";
      if (!value) {
        throw new Error(`${argument} requires a file path value.`);
      }

      options.envFile = value;
      index += 1;
      continue;
    }

    if (argument.startsWith("--env=") || argument.startsWith("--env-file=")) {
      const [, value] = argument.split("=", 2);
      options.envFile = value ?? "";
      continue;
    }

    if (argument === "--profile") {
      const value = argv[index + 1] ?? "";
      if (!value) {
        throw new Error("--profile requires a profile name.");
      }

      options.profileFilter = value;
      index += 1;
      continue;
    }

    if (argument.startsWith("--profile=")) {
      const [, value] = argument.split("=", 2);
      options.profileFilter = value ?? "";
      continue;
    }

    positional.push(argument);
  }

  if (positional[0]) {
    options.command = positional[0];
  }

  if (positional[1] && !options.profileFilter) {
    options.profileFilter = positional[1];
  }

  return options;
}

function groupProfilesByTelegramToken(profileRuntimes) {
  const groups = new Map();

  for (const runtime of profileRuntimes) {
    const token = runtime.profile.telegram.token;
    const existing = groups.get(token) ?? {
      pollTimeoutSeconds: runtime.profile.telegram.pollTimeoutSeconds,
      profileRuntimes: [],
      token,
      tokenStateKey: runtime.profile.telegram.tokenStateKey,
    };

    existing.profileRuntimes.push(runtime);
    groups.set(token, existing);
  }

  return [...groups.values()];
}

function isVkReady(vkConfig) {
  return Boolean(vkConfig?.accessToken && vkConfig?.groupId);
}

function isMaxReady(maxConfig) {
  return Boolean(maxConfig?.accessToken && maxConfig?.chatId);
}

function getNetworkErrorCode(error) {
  return error?.cause?.code ?? error?.code ?? null;
}

function sanitizeErrorMessage(message) {
  return String(message ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function readBooleanEnv(name, fallbackValue) {
  const rawValue = process.env[name];
  if (rawValue == null || rawValue === "") {
    return fallbackValue;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallbackValue;
}

function formatTelegramCheckError(error) {
  const code = getNetworkErrorCode(error);

  if (code === "UND_ERR_CONNECT_TIMEOUT") {
    return [
      "Telegram API is unreachable from this network (connect timeout).",
      'Try again in 1-2 minutes, switch network/VPN, or set TELEGRAM_API_BASE_URL in ".env".',
    ].join(" ");
  }

  if (code === "UND_ERR_SOCKET") {
    return [
      "Telegram API socket closed by remote side while connecting.",
      'Usually this is a temporary route/provider issue. Retry or use VPN/proxy (TELEGRAM_API_BASE_URL).',
    ].join(" ");
  }

  const message = sanitizeErrorMessage(error?.message);
  return message || "Unknown Telegram network error.";
}

function formatPlatformCheckError(platformName, error) {
  const code = getNetworkErrorCode(error);

  if (code === "UND_ERR_CONNECT_TIMEOUT") {
    return `${platformName} API is unreachable from this network (connect timeout).`;
  }

  if (code === "UND_ERR_SOCKET") {
    return `${platformName} socket was closed by remote side during request.`;
  }

  const message = sanitizeErrorMessage(error?.message);
  return message || `Unknown ${platformName} error.`;
}

function getStartPreflightOptions() {
  return {
    enabled: readBooleanEnv("START_PREFLIGHT_CHECK", true),
    requireVkPhotoUpload: readBooleanEnv("START_PREFLIGHT_REQUIRE_VK_PHOTO", true),
  };
}

async function buildProfileRuntimes(config) {
  const telegramClients = new Map();
  const runtimes = [];

  for (const profile of config.profiles) {
    let telegramClient = telegramClients.get(profile.telegram.token);

    if (!telegramClient) {
      telegramClient = new TelegramClient(profile.telegram.token);
      telegramClients.set(profile.telegram.token, telegramClient);
    }

    runtimes.push(
      await createProfileRuntime(profile, {
        telegramClient,
        vkPublisher: isVkReady(profile.vk) ? new VkPublisher(profile.vk) : null,
        maxPublisher: isMaxReady(profile.max) ? new MaxPublisher(profile.max) : null,
        processedStore: new ProcessedStore(profile.processedStateFile),
      }),
    );
  }

  return runtimes;
}

async function runCheck(config) {
  const telegramInfoByToken = new Map();
  const telegramErrorByToken = new Map();

  for (const profile of config.profiles) {
    const token = profile.telegram.token;
    if (!telegramInfoByToken.has(token) && !telegramErrorByToken.has(token)) {
      const telegramClient = new TelegramClient(profile.telegram.token);
      try {
        telegramInfoByToken.set(token, await telegramClient.getMe());
      } catch (error) {
        telegramErrorByToken.set(token, error);
      }
    }
  }

  for (const profile of config.profiles) {
    const telegramInfo = telegramInfoByToken.get(profile.telegram.token);
    if (telegramInfo) {
      log(
        `[${profile.name}] Telegram OK via @${telegramInfo.username}; source ${profile.telegram.sourceChatId || `@${profile.telegram.sourceChatUsername}`}.`,
      );
    } else {
      const telegramError = telegramErrorByToken.get(profile.telegram.token);
      warn(
        `[${profile.name}] Telegram check failed: ${formatTelegramCheckError(telegramError)}`,
      );
    }

    if (isVkReady(profile.vk)) {
      try {
        const vkPublisher = new VkPublisher(profile.vk);
        const vkInfo = await vkPublisher.check();
        const mediaTokenMode = profile.vk.mediaAccessToken
          ? "separate media token"
          : "single token";
        if (vkInfo.wallReadAvailable && vkInfo.photoUploadAvailable) {
          log(
            `[${profile.name}] VK OK (${mediaTokenMode}): ${vkInfo.latestPostsCount} recent posts visible, photo upload is available.`,
          );
        } else if (!vkInfo.wallReadAvailable && !vkInfo.photoUploadAvailable) {
          if (vkInfo.photoUploadIssue === "media_token_bound_to_ip") {
            warn(
              `[${profile.name}] VK connected (${mediaTokenMode}), but media token is bound to another IP. Recreate FOOTBALL_VK_MEDIA_ACCESS_TOKEN from this same network.`,
            );
          } else {
            warn(
              `[${profile.name}] VK connected (${mediaTokenMode}) with token restrictions: wall.get and photo upload are unavailable for this token type.`,
            );
          }
        } else if (!vkInfo.photoUploadAvailable) {
          if (vkInfo.photoUploadIssue === "media_token_bound_to_ip") {
            warn(
              `[${profile.name}] VK connected (${mediaTokenMode}), but photo upload is blocked: media token is bound to another IP. Recreate media token from this same network.`,
            );
          } else {
            warn(
              `[${profile.name}] VK connected (${mediaTokenMode}), but photo upload is unavailable for this token type.`,
            );
          }
        } else {
          warn(
            `[${profile.name}] VK connected (${mediaTokenMode}), but wall.get is unavailable for this token type.`,
          );
        }
      } catch (error) {
        warn(
          `[${profile.name}] VK check failed: ${formatPlatformCheckError("VK", error)}`,
        );
      }
    } else if (profile.vk?.accessToken) {
      log(`[${profile.name}] VK token set, but VK_GROUP_ID is missing.`);
    }

    if (isMaxReady(profile.max)) {
      try {
        const maxPublisher = new MaxPublisher(profile.max);
        const maxInfo = await maxPublisher.check();
        log(
          `[${profile.name}] MAX OK: chat "${maxInfo.chatTitle}" (${maxInfo.chatStatus}), membership ${maxInfo.membershipStatus}.`,
        );
      } catch (error) {
        warn(
          `[${profile.name}] MAX check failed: ${formatPlatformCheckError("MAX", error)}`,
        );
      }
    } else if (profile.max?.accessToken) {
      log(
        `[${profile.name}] MAX token set, but MAX_CHAT_ID is missing. Run "npm run max:chats -- ${profile.name}" after the bot is added to the target chat.`,
      );
    }
  }
}

async function runStartPreflight(config, options = {}) {
  const {
    requireVkPhotoUpload = true,
  } = options;
  const telegramInfoByToken = new Map();

  for (const profile of config.profiles) {
    const token = profile.telegram.token;
    if (telegramInfoByToken.has(token)) {
      continue;
    }

    const telegramClient = new TelegramClient(token);
    try {
      const info = await telegramClient.getMe();
      telegramInfoByToken.set(token, info);
      log(
        `[${profile.name}] Preflight Telegram OK via @${info.username}.`,
      );
    } catch (error) {
      throw new Error(
        `[${profile.name}] Preflight failed: Telegram is not reachable. ${formatTelegramCheckError(error)}`,
      );
    }
  }

  for (const profile of config.profiles) {
    if (isVkReady(profile.vk)) {
      const mediaTokenMode = profile.vk.mediaAccessToken
        ? "separate media token"
        : "single token";
      try {
        const vkPublisher = new VkPublisher(profile.vk);
        const vkInfo = await vkPublisher.check();

        if (requireVkPhotoUpload && !vkInfo.photoUploadAvailable) {
          if (vkInfo.photoUploadIssue === "media_token_bound_to_ip") {
            throw new Error(
              `[${profile.name}] Preflight failed: VK photo upload is blocked (${mediaTokenMode}) because media token is bound to another IP. Recreate FOOTBALL_VK_MEDIA_ACCESS_TOKEN from this same network before start.`,
            );
          }

          throw new Error(
            `[${profile.name}] Preflight failed: VK photo upload is unavailable (${mediaTokenMode}) for this token type. Start is blocked because START_PREFLIGHT_REQUIRE_VK_PHOTO=true.`,
          );
        }

        if (!vkInfo.wallReadAvailable) {
          warn(
            `[${profile.name}] Preflight VK warning: wall.get is unavailable for this token type, but posting can still work.`,
          );
        } else {
          log(
            `[${profile.name}] Preflight VK OK: wall read available.`,
          );
        }

        if (vkInfo.photoUploadAvailable) {
          log(
            `[${profile.name}] Preflight VK OK: photo upload available (${mediaTokenMode}).`,
          );
        }
      } catch (error) {
        if (
          typeof error?.message === "string" &&
          error.message.includes("Preflight failed:")
        ) {
          throw error;
        }

        throw new Error(
          `[${profile.name}] Preflight failed: ${formatPlatformCheckError("VK", error)}`,
        );
      }
    }

    if (isMaxReady(profile.max)) {
      try {
        const maxPublisher = new MaxPublisher(profile.max);
        const maxInfo = await maxPublisher.check();
        log(
          `[${profile.name}] Preflight MAX OK: chat "${maxInfo.chatTitle}" (${maxInfo.chatStatus}), membership ${maxInfo.membershipStatus}.`,
        );
      } catch (error) {
        throw new Error(
          `[${profile.name}] Preflight failed: ${formatPlatformCheckError("MAX", error)}`,
        );
      }
    }
  }

  log("Preflight passed. Starting polling loop.");
}

async function runMaxChats(config, profileFilter) {
  const maxProfiles = profileFilter
    ? config.profiles.filter((profile) => profile.name === profileFilter)
    : config.profiles.filter((profile) => profile.max?.accessToken);

  if (maxProfiles.length === 0) {
    throw new Error("No MAX-enabled profiles found for max:chats.");
  }

  for (const profile of maxProfiles) {
    const maxPublisher = new MaxPublisher(profile.max);
    const chats = await maxPublisher.listChats();

    if (chats.length === 0) {
      log(`[${profile.name}] MAX returned no chats for this bot yet.`);
      continue;
    }

    for (const chat of chats) {
      log(
        `[${profile.name}] chat_id=${chat.chat_id} | title=${chat.title ?? "(no title)"} | status=${chat.status} | public=${chat.is_public}`,
      );
    }
  }
}

async function runStart(config) {
  const preflightOptions = getStartPreflightOptions();
  if (preflightOptions.enabled) {
    await runStartPreflight(config, {
      requireVkPhotoUpload: preflightOptions.requireVkPhotoUpload,
    });
  } else {
    warn("Start preflight is disabled by START_PREFLIGHT_CHECK=false.");
  }

  const offsetStore = new OffsetStore(config.offsetsStateFile);
  await offsetStore.load();

  const profileRuntimes = await buildProfileRuntimes(config);
  const apps = groupProfilesByTelegramToken(profileRuntimes).map(
    (group) =>
      new CrossposterApp({
        offsetStore,
        pollTimeoutSeconds: group.pollTimeoutSeconds,
        profileRuntimes: group.profileRuntimes,
        telegramClient: group.profileRuntimes[0].telegramClient,
        tokenStateKey: group.tokenStateKey,
      }),
  );

  await Promise.all(apps.map((app) => app.run()));
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.envFile) {
    loadDotEnv(path.resolve(process.cwd(), cli.envFile));
    log(`Loaded environment from ${cli.envFile}.`);
  } else {
    loadDotEnv();
  }

  const command = cli.command;
  const profileFilter = cli.profileFilter;
  const config = readConfig({ command });

  switch (command) {
    case "start":
      await runStart(config);
      break;
    case "check":
      await runCheck(config);
      break;
    case "max:chats":
      await runMaxChats(config, profileFilter);
      break;
    default:
      throw new Error(`Unknown command "${command}".`);
  }
}

main().catch((caughtError) => {
  console.error(caughtError);
  process.exitCode = 1;
});
