export type TelegramUser = {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

export type TelegramChat = {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_forum?: boolean;
};

export type TelegramMessageEntity = {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: TelegramUser;
};

export type TelegramPhotoSize = {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
};

export type TelegramDocument = {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

export type TelegramMessage = {
  message_id: number;
  message_thread_id?: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  entities?: TelegramMessageEntity[];
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  caption?: string;
  is_topic_message?: boolean;
  reply_to_message?: TelegramMessage;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  my_chat_member?: {
    chat: TelegramChat;
    from: TelegramUser;
    new_chat_member: {
      user: TelegramUser;
      status: string;
    };
  };
};

export type TelegramForumTopic = {
  message_thread_id: number;
  name: string;
  icon_color: number;
  icon_custom_emoji_id?: string;
};

export type TelegramBotInfo = {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
  can_join_groups: boolean;
  can_read_all_group_messages: boolean;
  supports_inline_queries: boolean;
};

export type ParsedTelegramUpdate = {
  chatId: number;
  chatType: TelegramChat["type"];
  chatTitle: string | null;
  messageThreadId: number | null;
  fromUser: TelegramUser | null;
  text: string;
  hasMedia: boolean;
  isForumTopic: boolean;
  isBotCommand: boolean;
  command: string | null;
  commandPayload: string | null;
  messageId: number;
  isForum: boolean;
  photo: TelegramPhotoSize[] | null;
  document: TelegramDocument | null;
  caption: string | null;
};
