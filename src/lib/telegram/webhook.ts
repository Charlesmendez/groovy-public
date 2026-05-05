import type { TelegramUpdate, ParsedTelegramUpdate } from "./types";
import { timingSafeEqual } from "crypto";

export function verifyTelegramWebhook(req: Request, expectedSecret: string): boolean {
  const header = req.headers.get("x-telegram-bot-api-secret-token") || "";
  if (!header || !expectedSecret || header.length !== expectedSecret.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expectedSecret));
}

export function parseTelegramUpdate(body: unknown): ParsedTelegramUpdate | null {
  if (!body || typeof body !== "object") return null;

  const update = body as TelegramUpdate;
  const message = update.message || update.edited_message;
  if (!message) return null;

  const text = message.text || message.caption || "";
  const entities = message.entities || [];

  let command: string | null = null;
  let commandPayload: string | null = null;
  const botCommandEntity = entities.find((e) => e.type === "bot_command" && e.offset === 0);
  if (botCommandEntity) {
    const rawCommand = text.slice(botCommandEntity.offset, botCommandEntity.offset + botCommandEntity.length);
    const atIdx = rawCommand.indexOf("@");
    command = atIdx >= 0 ? rawCommand.slice(0, atIdx) : rawCommand;
    commandPayload = text.slice(botCommandEntity.offset + botCommandEntity.length).trim() || null;
  }

  const isMention = entities.some((e) => e.type === "mention");

  return {
    chatId: message.chat.id,
    chatType: message.chat.type,
    chatTitle: message.chat.title || null,
    messageThreadId: message.message_thread_id || null,
    fromUser: message.from || null,
    text,
    hasMedia: !!(message.photo?.length || message.document),
    isForumTopic: message.is_topic_message === true || !!message.message_thread_id,
    isBotCommand: !!command,
    command,
    commandPayload,
    messageId: message.message_id,
    isForum: message.chat.is_forum === true,
    photo: message.photo || null,
    document: message.document || null,
    caption: message.caption || null,
  };
}

export function buildTelegramThreadKey(chatId: number, messageThreadId: number | null): string {
  if (messageThreadId) {
    return `tg:${chatId}:${messageThreadId}`;
  }
  return `tg:${chatId}`;
}

export function parseTelegramThreadKey(threadKey: string): {
  chatId: number;
  messageThreadId: number | null;
} | null {
  if (!threadKey.startsWith("tg:")) return null;
  const parts = threadKey.slice(3).split(":");
  const chatId = Number(parts[0]);
  if (!Number.isFinite(chatId)) return null;
  const messageThreadId = parts[1] ? Number(parts[1]) : null;
  if (messageThreadId !== null && !Number.isFinite(messageThreadId)) return null;
  return { chatId, messageThreadId };
}

export function shouldProcessMessage(
  parsed: ParsedTelegramUpdate,
  botUsername: string,
): boolean {
  if (parsed.chatType === "private") return true;

  if (parsed.isBotCommand) return true;

  const lowerText = parsed.text.toLowerCase();
  const mentionTag = `@${botUsername.toLowerCase()}`;
  if (lowerText.includes(mentionTag)) return true;

  if (parsed.isForumTopic) return true;

  return false;
}

export function extractMessageText(parsed: ParsedTelegramUpdate, botUsername: string): string {
  let text = parsed.text;
  if (parsed.command) {
    text = parsed.commandPayload || "";
  } else {
    const mentionTag = `@${botUsername}`;
    const mentionTagLower = mentionTag.toLowerCase();
    const lowerText = text.toLowerCase();
    const idx = lowerText.indexOf(mentionTagLower);
    if (idx >= 0) {
      text = (text.slice(0, idx) + text.slice(idx + mentionTag.length)).trim();
    }
  }
  return text.trim();
}
