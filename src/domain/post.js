function getPostText(message) {
  return message.caption ?? message.text ?? "";
}

function selectLargestPhoto(message) {
  if (!Array.isArray(message.photo) || message.photo.length === 0) {
    return null;
  }

  return [...message.photo].sort((left, right) => {
    const leftArea = (left.width ?? 0) * (left.height ?? 0);
    const rightArea = (right.width ?? 0) * (right.height ?? 0);
    return rightArea - leftArea;
  })[0];
}

function detectUnsupportedTypes(message) {
  const unsupported = [];
  const possibleTypes = [
    "video",
    "animation",
    "document",
    "audio",
    "voice",
    "video_note",
    "sticker",
    "poll",
  ];

  for (const type of possibleTypes) {
    if (message[type]) {
      unsupported.push(type);
    }
  }

  return unsupported;
}

export function normalizeTelegramMessages(messages, { postPrefix = "" } = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }

  const sortedMessages = [...messages].sort(
    (left, right) => left.message_id - right.message_id,
  );
  const firstMessage = sortedMessages[0];
  const chat = firstMessage.chat ?? {};
  const firstText = sortedMessages.map(getPostText).find(Boolean) ?? "";
  const photos = sortedMessages
    .map((message) => selectLargestPhoto(message))
    .filter(Boolean)
    .map((photo) => ({
      telegramFileId: photo.file_id,
      telegramUniqueId: photo.file_unique_id,
      width: photo.width,
      height: photo.height,
      fileSize: photo.file_size,
    }));
  const unsupportedTypes = [
    ...new Set(sortedMessages.flatMap((message) => detectUnsupportedTypes(message))),
  ];
  const textParts = [postPrefix.trim(), firstText.trim()].filter(Boolean);
  const text = textParts.join("\n\n");

  if (!text && photos.length === 0) {
    return null;
  }

  return {
    key: firstMessage.media_group_id
      ? `tg:${chat.id}:media:${firstMessage.media_group_id}`
      : `tg:${chat.id}:message:${firstMessage.message_id}`,
    telegram: {
      chatId: String(chat.id),
      title: chat.title ?? "",
      username: chat.username ?? "",
      mediaGroupId: firstMessage.media_group_id ?? null,
      messageIds: sortedMessages.map((message) => message.message_id),
      messageDate: firstMessage.date ?? null,
    },
    text,
    photos,
    unsupportedTypes,
  };
}
