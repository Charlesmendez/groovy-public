import type {
  TelegramBotInfo,
  TelegramChat,
  TelegramForumTopic,
  TelegramMessage,
} from "./types";

const BASE_URL = "https://api.telegram.org";

type TelegramApiResult<T> = { ok: true; result: T } | { ok: false; description: string; error_code: number };

async function callTelegramApi<T>(
  botToken: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const url = `${BASE_URL}/bot${botToken}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as TelegramApiResult<T>;
  if (!json.ok) {
    throw new Error(`Telegram API ${method} failed: ${json.error_code} ${json.description}`);
  }
  return json.result;
}

export async function getTelegramMe(botToken: string): Promise<TelegramBotInfo> {
  return callTelegramApi<TelegramBotInfo>(botToken, "getMe");
}

export async function getTelegramChat(botToken: string, chatId: number | string): Promise<TelegramChat> {
  return callTelegramApi<TelegramChat>(botToken, "getChat", { chat_id: chatId });
}

export async function sendTelegramText(args: {
  botToken: string;
  chatId: number | string;
  text: string;
  messageThreadId?: number;
  parseMode?: "HTML" | "MarkdownV2";
}): Promise<TelegramMessage> {
  return callTelegramApi<TelegramMessage>(args.botToken, "sendMessage", {
    chat_id: args.chatId,
    text: args.text,
    ...(args.messageThreadId ? { message_thread_id: args.messageThreadId } : {}),
    ...(args.parseMode ? { parse_mode: args.parseMode } : {}),
  });
}

export async function sendTelegramPhoto(args: {
  botToken: string;
  chatId: number | string;
  photo: string;
  caption?: string;
  messageThreadId?: number;
}): Promise<TelegramMessage> {
  return callTelegramApi<TelegramMessage>(args.botToken, "sendPhoto", {
    chat_id: args.chatId,
    photo: args.photo,
    ...(args.caption ? { caption: args.caption } : {}),
    ...(args.messageThreadId ? { message_thread_id: args.messageThreadId } : {}),
  });
}

export async function sendTelegramDocument(args: {
  botToken: string;
  chatId: number | string;
  document: string;
  filename?: string;
  caption?: string;
  messageThreadId?: number;
}): Promise<TelegramMessage> {
  return callTelegramApi<TelegramMessage>(args.botToken, "sendDocument", {
    chat_id: args.chatId,
    document: args.document,
    ...(args.filename ? { filename: args.filename } : {}),
    ...(args.caption ? { caption: args.caption } : {}),
    ...(args.messageThreadId ? { message_thread_id: args.messageThreadId } : {}),
  });
}

export async function sendTelegramChatAction(args: {
  botToken: string;
  chatId: number | string;
  action: "typing" | "upload_photo" | "upload_document";
  messageThreadId?: number;
}): Promise<boolean> {
  return callTelegramApi<boolean>(args.botToken, "sendChatAction", {
    chat_id: args.chatId,
    action: args.action,
    ...(args.messageThreadId ? { message_thread_id: args.messageThreadId } : {}),
  });
}

export async function setTelegramWebhook(args: {
  botToken: string;
  url: string;
  secretToken: string;
  allowedUpdates?: string[];
}): Promise<boolean> {
  return callTelegramApi<boolean>(args.botToken, "setWebhook", {
    url: args.url,
    secret_token: args.secretToken,
    allowed_updates: args.allowedUpdates ?? ["message", "edited_message", "my_chat_member"],
    max_connections: 40,
  });
}

export async function deleteTelegramWebhook(botToken: string): Promise<boolean> {
  return callTelegramApi<boolean>(botToken, "deleteWebhook");
}

export async function setTelegramBotCommands(
  botToken: string,
  commands: { command: string; description: string }[],
): Promise<boolean> {
  return callTelegramApi<boolean>(botToken, "setMyCommands", { commands });
}

export async function createTelegramForumTopic(args: {
  botToken: string;
  chatId: number | string;
  name: string;
}): Promise<TelegramForumTopic> {
  return callTelegramApi<TelegramForumTopic>(args.botToken, "createForumTopic", {
    chat_id: args.chatId,
    name: args.name,
  });
}

export async function getTelegramFile(botToken: string, fileId: string): Promise<{ file_path: string }> {
  return callTelegramApi<{ file_path: string }>(botToken, "getFile", { file_id: fileId });
}

export function getTelegramFileUrl(botToken: string, filePath: string): string {
  return `${BASE_URL}/file/bot${botToken}/${filePath}`;
}
