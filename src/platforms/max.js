import { Blob } from "node:buffer";

import { HttpError, requestJson } from "../utils/http.js";
import { sleep } from "../utils/sleep.js";

export class MaxPublisher {
  constructor({
    accessToken,
    chatId,
    attachmentReadyRetries,
    attachmentReadyDelayMs,
  }) {
    this.accessToken = accessToken;
    this.chatId = chatId;
    this.attachmentReadyRetries = attachmentReadyRetries;
    this.attachmentReadyDelayMs = attachmentReadyDelayMs;
    this.apiBaseUrl = "https://platform-api.max.ru";
  }

  async check() {
    if (!this.chatId) {
      throw new Error("MAX chat id is required for check().");
    }

    const [bot, chat, membership] = await Promise.all([
      this.request("/me"),
      this.request(`/chats/${this.chatId}`),
      this.request(`/chats/${this.chatId}/members/me`),
    ]);

    return {
      botId: bot.user_id,
      botName: bot.first_name ?? bot.username ?? "unknown",
      chatTitle: chat.title,
      chatStatus: chat.status,
      membershipStatus: membership.status,
    };
  }

  async listChats() {
    const response = await this.request("/chats", {
      query: {
        count: 100,
      },
    });

    return response.chats ?? [];
  }

  async publish(post) {
    if (!this.chatId) {
      throw new Error("MAX chat id is required for publish().");
    }

    const attachments = [];

    for (const asset of post.media) {
      attachments.push(await this.#uploadImage(asset));
    }

    const body = {};

    if (post.text) {
      body.text = post.text;
    }

    if (attachments.length > 0) {
      body.attachments = attachments;
    }

    return this.#sendWithAttachmentRetry(body);
  }

  async request(path, options = {}) {
    return requestJson(`${this.apiBaseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: this.accessToken,
        ...(options.headers ?? {}),
      },
      timeoutMs: options.timeoutMs ?? 60_000,
    });
  }

  async #uploadImage(asset) {
    const uploadTicket = await this.request("/uploads", {
      method: "POST",
      query: {
        type: "image",
      },
    });

    const form = new FormData();
    form.set(
      "data",
      new Blob([asset.buffer], {
        type: asset.mimeType,
      }),
      asset.filename,
    );

    const payload = await requestJson(uploadTicket.url, {
      method: "POST",
      headers: {
        Authorization: this.accessToken,
      },
      form,
      timeoutMs: 120_000,
    });

    return {
      type: "image",
      payload,
    };
  }

  async #sendWithAttachmentRetry(body) {
    let delayMs = this.attachmentReadyDelayMs;

    for (let attempt = 0; attempt <= this.attachmentReadyRetries; attempt += 1) {
      try {
        return await this.request("/messages", {
          method: "POST",
          query: {
            chat_id: this.chatId,
          },
          json: body,
        });
      } catch (error) {
        const shouldRetry =
          body.attachments?.length > 0 &&
          error instanceof HttpError &&
          error.body?.code === "attachment.not.ready" &&
          attempt < this.attachmentReadyRetries;

        if (!shouldRetry) {
          throw error;
        }

        await sleep(delayMs);
        delayMs *= 2;
      }
    }

    throw new Error("MAX publish retry loop exited unexpectedly.");
  }
}
