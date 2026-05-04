export type WhatsAppPendingSend = {
  chatId: string;
  recipientDisplay?: string;
  text?: string;
  media?: Array<{
    url?: string;
    localPath?: string;
    storagePath?: string;
    fileId?: string;
    filename?: string;
    caption?: string;
  }>;
};

export function extractWhatsAppSendConfirmation(input: string): {
  cleanText: string;
  pendingSend: WhatsAppPendingSend | null;
} {
  const raw = typeof input === "string" ? input : String(input || "");
  const open = "<whatsapp_send_confirmation>";
  const close = "</whatsapp_send_confirmation>";
  const start = raw.indexOf(open);
  if (start < 0) return { cleanText: raw, pendingSend: null };
  const end = raw.indexOf(close, start + open.length);
  if (end < 0) return { cleanText: raw, pendingSend: null };

  const jsonText = raw.slice(start + open.length, end).trim();
  let pendingSend: WhatsAppPendingSend | null = null;
  try {
    const parsed = JSON.parse(jsonText) as {
      recipient?: { display?: unknown; chatId?: unknown } | null;
      chatId?: unknown;
      recipientDisplay?: unknown;
      text?: unknown;
      media?: unknown;
      files?: unknown;
      attachments?: unknown;
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
    const mediaRaw = Array.isArray(parsed?.media)
      ? parsed.media
      : Array.isArray(parsed?.files)
        ? parsed.files
        : Array.isArray(parsed?.attachments)
          ? parsed.attachments
          : [];
    const media: NonNullable<WhatsAppPendingSend["media"]> = [];
    for (const rawEntry of mediaRaw) {
      if (!rawEntry || typeof rawEntry !== "object") continue;
      const entry = rawEntry as Record<string, unknown>;
      const url =
        typeof entry.url === "string" && entry.url.trim() ? entry.url.trim() : undefined;
      const storagePath =
        typeof entry.storage_path === "string" && entry.storage_path.trim()
          ? entry.storage_path.trim()
          : typeof entry.storagePath === "string" && entry.storagePath.trim()
            ? entry.storagePath.trim()
            : undefined;
      const localPath =
        typeof entry.local_path === "string" && entry.local_path.trim()
          ? entry.local_path.trim()
          : typeof entry.localPath === "string" && entry.localPath.trim()
            ? entry.localPath.trim()
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
          : typeof entry.name === "string" && entry.name.trim()
            ? entry.name.trim()
            : undefined;
      const caption =
        typeof entry.caption === "string" && entry.caption.trim()
          ? entry.caption.trim()
          : undefined;

      if (!url && !localPath && !storagePath && !fileId) continue;

      const nextEntry: NonNullable<WhatsAppPendingSend["media"]>[number] = {};
      if (url) nextEntry.url = url;
      if (localPath) nextEntry.localPath = localPath;
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

