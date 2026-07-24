export type NativeChatNotificationPayload = {
  messageId: string;
  channelId: string;
  title: string;
  body: string;
  url: string;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > maximum) return null;
  return normalized;
}

export function parseNativeChatNotificationPayload(
  input: unknown
): NativeChatNotificationPayload | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const candidate = input as Record<string, unknown>;
  const messageId = boundedText(candidate.messageId, 64);
  const channelId = boundedText(candidate.channelId, 64);
  const title = boundedText(candidate.title, 160);
  const body = boundedText(candidate.body, 500);
  const url = boundedText(candidate.url, 100);
  if (
    !messageId ||
    !channelId ||
    !title ||
    !body ||
    !url ||
    !UUID_PATTERN.test(messageId) ||
    !UUID_PATTERN.test(channelId) ||
    url !== `/chat/${channelId}`
  ) {
    return null;
  }
  return { messageId, channelId, title, body, url };
}

export class NativeNotificationDeduper {
  private readonly ids = new Set<string>();

  constructor(private readonly maximum = 500) {}

  has(messageId: string): boolean {
    return this.ids.has(messageId);
  }

  add(messageId: string): void {
    this.ids.delete(messageId);
    this.ids.add(messageId);
    while (this.ids.size > this.maximum) {
      const oldest = this.ids.values().next().value;
      if (typeof oldest !== "string") break;
      this.ids.delete(oldest);
    }
  }
}
