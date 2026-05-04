export type TelegramPendingSend = {
  chatId: string;
  recipientDisplay?: string;
  text?: string;
  messageThreadId?: number;
  media?: Array<{
    url?: string;
    storagePath?: string;
    fileId?: string;
    filename?: string;
    caption?: string;
  }>;
};

export function extractTelegramSendConfirmation(input: string): {
  cleanText: string;
  pendingSend: TelegramPendingSend | null;
} {
  const raw = typeof input === "string" ? input : String(input || "");
  const open = "<telegram_send_confirmation>";
  const close = "</telegram_send_confirmation>";
  const start = raw.indexOf(open);
  if (start < 0) return { cleanText: raw, pendingSend: null };
  const end = raw.indexOf(close, start + open.length);
  if (end < 0) return { cleanText: raw, pendingSend: null };

  const jsonText = raw.slice(start + open.length, end).trim();
  let pendingSend: TelegramPendingSend | null = null;
  try {
    const parsed = JSON.parse(jsonText) as {
      recipient?: { display?: unknown; chatId?: unknown } | null;
      chatId?: unknown;
      recipientDisplay?: unknown;
      text?: unknown;
      message_thread_id?: unknown;
      messageThreadId?: unknown;
      media?: unknown;
      files?: unknown;
    };
    const chatId =
      (parsed?.recipient && typeof parsed.recipient === "object" && typeof parsed.recipient.chatId === "string"
        ? parsed.recipient.chatId
        : typeof parsed?.chatId === "string"
          ? parsed.chatId
          : "") || "";
    const text = typeof parsed?.text === "string" ? parsed.text.trim() : "";
    const recipientDisplay =
      (parsed?.recipient && typeof parsed.recipient === "object" && typeof parsed.recipient.display === "string"
        ? parsed.recipient.display
        : typeof parsed?.recipientDisplay === "string"
          ? parsed.recipientDisplay
          : undefined) || undefined;
    const messageThreadId =
      typeof parsed?.message_thread_id === "number"
        ? parsed.message_thread_id
        : typeof parsed?.messageThreadId === "number"
          ? parsed.messageThreadId
          : undefined;
    const mediaRaw = Array.isArray(parsed?.media)
      ? parsed.media
      : Array.isArray(parsed?.files)
        ? parsed.files
        : [];
    const media: NonNullable<TelegramPendingSend["media"]> = [];
    for (const rawEntry of mediaRaw) {
      if (!rawEntry || typeof rawEntry !== "object") continue;
      const entry = rawEntry as Record<string, unknown>;
      const url = typeof entry.url === "string" && entry.url.trim() ? entry.url.trim() : undefined;
      const storagePath =
        typeof entry.storage_path === "string" && entry.storage_path.trim()
          ? entry.storage_path.trim()
          : typeof entry.storagePath === "string" && entry.storagePath.trim()
            ? entry.storagePath.trim()
            : undefined;
      const fileId =
        typeof entry.file_id === "string" && entry.file_id.trim()
          ? entry.file_id.trim()
          : typeof entry.fileId === "string" && entry.fileId.trim()
            ? entry.fileId.trim()
            : undefined;
      const filename =
        typeof entry.filename === "string" && entry.filename.trim()
          ? entry.filename.trim()
          : undefined;
      const caption =
        typeof entry.caption === "string" && entry.caption.trim()
          ? entry.caption.trim()
          : undefined;

      if (!url && !storagePath && !fileId) continue;
      const nextEntry: NonNullable<TelegramPendingSend["media"]>[number] = {};
      if (url) nextEntry.url = url;
      if (storagePath) nextEntry.storagePath = storagePath;
      if (fileId) nextEntry.fileId = fileId;
      if (filename) nextEntry.filename = filename;
      if (caption) nextEntry.caption = caption;
      media.push(nextEntry);
    }

    if (chatId.trim() && (text || media.length > 0)) {
      pendingSend = {
        chatId: chatId.trim(),
        ...(text ? { text } : {}),
        ...(recipientDisplay?.trim() ? { recipientDisplay: recipientDisplay.trim() } : {}),
        ...(messageThreadId ? { messageThreadId } : {}),
        ...(media.length > 0 ? { media } : {}),
      };
    }
  } catch {
    pendingSend = null;
  }

  const before = raw.slice(0, start);
  const after = raw.slice(end + close.length);
  const cleanText = `${before}\n${after}`.replace(/\n{3,}/g, "\n\n").trim();
  return { cleanText, pendingSend };
}
