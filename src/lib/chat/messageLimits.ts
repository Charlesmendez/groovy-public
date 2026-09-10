export const MAX_CHAT_MESSAGE_CHARACTERS = 40_000;

export function chatMessageLengthError(content: string): string | null {
  const length = content.trim().length;
  if (length <= MAX_CHAT_MESSAGE_CHARACTERS) return null;
  return `This message is too long (${length.toLocaleString()} / ${MAX_CHAT_MESSAGE_CHARACTERS.toLocaleString()} characters). Shorten it or attach it as a text file. Your draft has been kept.`;
}

