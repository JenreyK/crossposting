import { Buffer } from "node:buffer";

import { requestJson } from "../utils/http.js";

export class VkPublisher {
  constructor({ accessToken, mediaAccessToken, groupId, apiVersion }) {
    this.accessToken = accessToken;
    this.mediaAccessToken = mediaAccessToken ?? null;
    this.groupId = Math.abs(groupId);
    this.apiVersion = apiVersion;
    this.apiBaseUrl = "https://api.vk.com/method";
  }

  async check() {
    let latestPostsCount = null;
    let wallReadAvailable = true;
    let tokenTypeHint = "unknown";
    let photoUploadIssue = null;

    try {
      const wallInfo = await this.call("wall.get", {
        owner_id: -this.groupId,
        count: 1,
      }, {
        accessToken: this.accessToken,
      });
      latestPostsCount = wallInfo.count;
    } catch (error) {
      if (error.vkErrorCode !== 27) {
        throw error;
      }

      // Some token types are blocked from wall.get even if the token itself is valid.
      wallReadAvailable = false;
      tokenTypeHint = "community";
    }

    let uploadUrl = null;
    let photoUploadAvailable = true;

    try {
      const uploadInfo = await this.call("photos.getWallUploadServer", {
        group_id: this.groupId,
      }, {
        accessToken: this.#getMediaToken(),
      });
      uploadUrl = uploadInfo.upload_url;
    } catch (error) {
      if (error.vkErrorCode === 27) {
        photoUploadAvailable = false;
        tokenTypeHint = "community";
        photoUploadIssue = "token_type_restriction";
      } else if (
        error.vkErrorCode === 5 &&
        typeof error.vkErrorMessage === "string" &&
        error.vkErrorMessage.toLowerCase().includes("another ip address")
      ) {
        photoUploadAvailable = false;
        photoUploadIssue = "media_token_bound_to_ip";
      } else {
        throw error;
      }
    }

    return {
      latestPostsCount,
      wallReadAvailable,
      uploadUrl,
      photoUploadAvailable,
      photoUploadIssue,
      tokenTypeHint,
    };
  }

  async publish(post) {
    const attachments = [];

    for (const asset of post.media) {
      attachments.push(await this.#uploadPhoto(asset));
    }

    let response;
    try {
      response = await this.call("wall.post", {
        owner_id: -this.groupId,
        from_group: 1,
        message: post.text || undefined,
        attachments: attachments.length > 0 ? attachments.join(",") : undefined,
      });
    } catch (error) {
      if (!(error.vkErrorCode === 27 && this.mediaAccessToken)) {
        throw error;
      }

      response = await this.call("wall.post", {
        owner_id: -this.groupId,
        from_group: 1,
        message: post.text || undefined,
        attachments: attachments.length > 0 ? attachments.join(",") : undefined,
      }, {
        accessToken: this.mediaAccessToken,
      });
    }

    return {
      ownerId: response.owner_id,
      postId: response.post_id,
    };
  }

  async call(method, params, { accessToken } = {}) {
    const formBody = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
      if (value == null || value === "") {
        continue;
      }

      formBody.set(key, String(value));
    }

    formBody.set("access_token", accessToken ?? this.accessToken);
    formBody.set("v", this.apiVersion);

    const response = await requestJson(`${this.apiBaseUrl}/${method}`, {
      method: "POST",
      body: formBody,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeoutMs: 60_000,
    });

    if (response.error) {
      throw this.#buildApiError(method, response.error);
    }

    return response.response;
  }

  #buildApiError(method, apiError) {
    let message;

    if (apiError.error_code === 27) {
      message = `VK API error in ${method}: ${apiError.error_msg} (code 27). This usually means you are using a community token, but ${method} requires a user access token from a VK account that manages the group.`;
    } else if (apiError.error_code === 5) {
      if (
        typeof apiError.error_msg === "string" &&
        apiError.error_msg.toLowerCase().includes("expired")
      ) {
        message = `VK API error in ${method}: ${apiError.error_msg} (code 5). The token expired. Recreate a fresh user access token and update FOOTBALL_VK_MEDIA_ACCESS_TOKEN.`;
      } else
      if (
        typeof apiError.error_msg === "string" &&
        apiError.error_msg.toLowerCase().includes("another ip address")
      ) {
        message = `VK API error in ${method}: ${apiError.error_msg} (code 5). This token is IP-bound. Recreate it from the same public IP where this script runs, or disable VPN/proxy mismatch.`;
      } else {
        message = `VK API error in ${method}: ${apiError.error_msg} (code 5). The token is invalid. Common causes: secure key instead of access token, revoked token, or token copied incorrectly.`;
      }
    } else {
      message = `VK API error in ${method}: ${apiError.error_msg} (code ${apiError.error_code})`;
    }

    const error = new Error(message);
    error.vkErrorCode = apiError.error_code;
    error.vkErrorMessage = apiError.error_msg;
    error.vkMethod = method;
    return error;
  }

  async #uploadPhoto(asset) {
    const uploadServer = await this.call("photos.getWallUploadServer", {
      group_id: this.groupId,
    }, {
      accessToken: this.#getMediaToken(),
    });

    let uploadResponse = await this.#uploadToVk(uploadServer.upload_url, asset, "photo");
    let rawPhotoPayload = uploadResponse?.photo ?? uploadResponse?.photos_list;
    let photoPayload = this.#normalizePhotoPayload(rawPhotoPayload);
    let uploadServerValue = uploadResponse?.server;
    let uploadHash = uploadResponse?.hash;

    // Some VK upload nodes accept file payload under "file1" for wall photo uploads.
    // Retry once using this fallback when the primary "photo" payload is empty.
    if (!photoPayload || photoPayload === "[]") {
      const fallbackResponse = await this.#uploadToVk(
        uploadServer.upload_url,
        asset,
        "file1",
      );
      const fallbackRawPayload =
        fallbackResponse?.photo ?? fallbackResponse?.photos_list;
      const fallbackPayload = this.#normalizePhotoPayload(fallbackRawPayload);

      if (fallbackPayload && fallbackPayload !== "[]") {
        uploadResponse = fallbackResponse;
        rawPhotoPayload = fallbackRawPayload;
        photoPayload = fallbackPayload;
        uploadServerValue = fallbackResponse?.server;
        uploadHash = fallbackResponse?.hash;
      }
    }

    if (!photoPayload || !uploadServerValue || !uploadHash) {
      throw new Error(
        `VK upload response is missing required fields (photo/photos_list, server, hash). Received keys: ${Object.keys(uploadResponse ?? {}).join(",") || "none"}.`,
      );
    }

    if (photoPayload === "[]") {
      throw new Error(
        `VK upload returned empty photo list for ${asset.filename} (mime=${asset.mimeType}, size=${asset.buffer?.length ?? "unknown"}, tgPath=${asset.telegramFilePath ?? "unknown"}, uploadKeys=${Object.keys(uploadResponse ?? {}).join(",") || "none"}). This usually means VK rejected the uploaded binary payload.`,
      );
    }

    let savedPhotos;
    try {
      savedPhotos = await this.call("photos.saveWallPhoto", {
        group_id: this.groupId,
        photo: photoPayload,
        server: uploadServerValue,
        hash: uploadHash,
      }, {
        accessToken: this.#getMediaToken(),
      });
    } catch (error) {
      const isPhotosListInvalid =
        error?.vkErrorCode === 100 &&
        typeof error?.vkErrorMessage === "string" &&
        error.vkErrorMessage.toLowerCase().includes("photos_list is invalid");

      if (!isPhotosListInvalid) {
        throw error;
      }

      // Some VK endpoints still validate this field as photos_list internally.
      savedPhotos = await this.call("photos.saveWallPhoto", {
        group_id: this.groupId,
        photos_list: photoPayload,
        server: uploadServerValue,
        hash: uploadHash,
      }, {
        accessToken: this.#getMediaToken(),
      });
    }

    const [savedPhoto] = savedPhotos;
    return `photo${savedPhoto.owner_id}_${savedPhoto.id}`;
  }

  #normalizePhotoPayload(rawValue) {
    if (rawValue == null) {
      return "";
    }

    if (typeof rawValue === "string") {
      const trimmed = rawValue.trim();

      if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
        try {
          const unwrapped = JSON.parse(trimmed);
          if (typeof unwrapped === "string") {
            return unwrapped;
          }
        } catch {
          // keep original value as-is
        }
      }

      return trimmed;
    }

    try {
      return JSON.stringify(rawValue);
    } catch {
      return String(rawValue);
    }
  }

  async #uploadToVk(uploadUrl, asset, fieldName) {
    const { body, boundary } = this.#buildMultipartBody(fieldName, asset);
    const uploadResponse = await requestJson(uploadUrl, {
      method: "POST",
      body,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(body.length),
      },
      timeoutMs: 120_000,
    });

    if (uploadResponse?.errcode || uploadResponse?.error) {
      throw new Error(
        `VK upload server returned error payload: ${JSON.stringify(uploadResponse)}`,
      );
    }

    return uploadResponse;
  }

  #buildMultipartBody(fieldName, asset) {
    const boundary = `----crossposting-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
    const safeFilename = this.#escapeMultipartFilename(asset.filename || "photo.jpg");
    const mimeType = asset.mimeType || "application/octet-stream";
    const preamble = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${safeFilename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
      "utf8",
    );
    const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const fileBuffer = Buffer.isBuffer(asset.buffer)
      ? asset.buffer
      : Buffer.from(asset.buffer);

    return {
      body: Buffer.concat([preamble, fileBuffer, epilogue]),
      boundary,
    };
  }

  #escapeMultipartFilename(filename) {
    return String(filename).replace(/["\\\r\n]/gu, "_");
  }

  #getMediaToken() {
    return this.mediaAccessToken ?? this.accessToken;
  }

  #getReadToken() {
    return this.accessToken;
  }
}
