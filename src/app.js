import { normalizeTelegramMessages } from "./domain/post.js";
import { error, log, warn } from "./utils/logger.js";
import { sleep } from "./utils/sleep.js";

function matchesSourceChat(message, telegramConfig) {
  const chat = message.chat ?? {};
  const chatId = String(chat.id ?? "");
  const username = String(chat.username ?? "").replace(/^@/u, "");

  if (telegramConfig.sourceChatId && chatId === telegramConfig.sourceChatId) {
    return true;
  }

  if (
    telegramConfig.sourceChatUsername &&
    username &&
    username.toLowerCase() === telegramConfig.sourceChatUsername.toLowerCase()
  ) {
    return true;
  }

  return false;
}

export class CrossposterApp {
  constructor({
    offsetStore,
    pollTimeoutSeconds,
    profileRuntimes,
    telegramClient,
    tokenStateKey,
  }) {
    this.offsetStore = offsetStore;
    this.pollTimeoutSeconds = pollTimeoutSeconds;
    this.profileRuntimes = profileRuntimes;
    this.telegramClient = telegramClient;
    this.tokenStateKey = tokenStateKey;
    this.mediaGroups = new Map();
  }

  async run() {
    await this.telegramClient.deleteWebhook();

    const me = await this.telegramClient.getMe();
    log(
      `Telegram bot @${me.username} is connected for profiles: ${this.profileRuntimes.map((runtime) => runtime.profile.name).join(", ")}.`,
    );

    while (true) {
      try {
        const updates = await this.telegramClient.getUpdates(
          this.offsetStore.getOffset(this.tokenStateKey),
          this.pollTimeoutSeconds,
        );

        if (updates.length === 0) {
          continue;
        }

        for (const update of updates) {
          await this.#handleUpdate(update);
        }
      } catch (caughtError) {
        error("Polling loop failed. Retrying in 5 seconds.", caughtError);
        await sleep(5_000);
      }
    }
  }

  async #handleUpdate(update) {
    const nextOffset = update.update_id + 1;
    const message = update.channel_post;

    if (!message) {
      await this.offsetStore.saveOffset(this.tokenStateKey, nextOffset);
      return;
    }

    const matchingProfiles = this.profileRuntimes.filter((runtime) =>
      matchesSourceChat(message, runtime.profile.telegram),
    );

    for (const runtime of matchingProfiles) {
      if (message.media_group_id) {
        this.#bufferMediaGroup(runtime, message);
      } else {
        await runtime.enqueuePublish([message]);
      }
    }

    await this.offsetStore.saveOffset(this.tokenStateKey, nextOffset);
  }

  #bufferMediaGroup(runtime, message) {
    const key = `${runtime.profile.name}:${message.chat.id}:${message.media_group_id}`;
    const existing = this.mediaGroups.get(key) ?? {
      messages: [],
      timer: null,
    };

    existing.messages.push(message);

    if (existing.timer) {
      clearTimeout(existing.timer);
    }

    existing.timer = setTimeout(() => {
      this.mediaGroups.delete(key);
      runtime.enqueuePublish(existing.messages).catch((caughtError) => {
        error(`Album ${key} failed during publish.`, caughtError);
      });
    }, runtime.profile.telegram.mediaGroupDelayMs);

    this.mediaGroups.set(key, existing);
  }
}

export async function createProfileRuntime(profile, { telegramClient, vkPublisher, maxPublisher, processedStore }) {
  await processedStore.load();

  const runtime = {
    profile,
    processedStore,
    telegramClient,
    vkPublisher,
    maxPublisher,
    publishQueue: Promise.resolve(),
  };

  runtime.enqueuePublish = async (messages) => {
    runtime.publishQueue = runtime.publishQueue
      .then(() => publishProfileMessages(runtime, messages))
      .catch((caughtError) => {
        error(`Publish queue failed for profile ${profile.name}.`, caughtError);
      });

    return runtime.publishQueue;
  };

  return runtime;
}

async function publishProfileMessages(runtime, messages) {
  const { profile, processedStore, telegramClient, vkPublisher, maxPublisher } =
    runtime;
  const post = normalizeTelegramMessages(messages, {
    postPrefix: profile.postPrefix,
  });

  if (!post) {
    warn(
      `Skipping Telegram post ${messages.map((message) => message.message_id).join(",")} for profile ${profile.name} because it contains no supported content.`,
    );
    return;
  }

  if (processedStore.hasProcessed(post.key)) {
    log(`Skipping already processed post ${post.key} for profile ${profile.name}.`);
    return;
  }

  if (post.unsupportedTypes.length > 0) {
    warn(
      `Post ${post.key} for profile ${profile.name} includes unsupported Telegram content: ${post.unsupportedTypes.join(", ")}. Text and photos will still be published.`,
    );
  }

  const hydratedPost = await telegramClient.hydratePost(post);
  const result = {};

  if (vkPublisher) {
    result.vk = await vkPublisher.publish(hydratedPost);
  }

  if (maxPublisher) {
    result.max = await maxPublisher.publish(hydratedPost);
  }

  await processedStore.markProcessed(post.key, result);
  log(
    `Published ${post.key} for profile ${profile.name} from Telegram channel ${post.telegram.title || post.telegram.chatId}.`,
  );
}
