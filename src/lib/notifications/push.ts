export const CHAT_NOTIFICATION_MODES = ["off", "mentions", "all"] as const;
export type ChatNotificationMode = (typeof CHAT_NOTIFICATION_MODES)[number];

export type BrowserPushSubscriptionInput = {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
};

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function unsafeEndpointHostname(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !value ||
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value.endsWith(".local") ||
    value.endsWith(".internal") ||
    (!value.includes(".") && !value.includes(":"))
  ) {
    return true;
  }
  if (value.includes(":")) {
    return (
      value === "::" ||
      value === "::1" ||
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      /^fe[89ab]/.test(value) ||
      value.startsWith("ff") ||
      value.startsWith("::ffff:")
    );
  }
  const octets = value.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some(
      (octet, index) =>
        !Number.isInteger(octet) ||
        octet < 0 ||
        octet > 255 ||
        String(octet) !== value.split(".")[index],
    )
  ) {
    return false;
  }
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function parseChatNotificationMode(
  input: unknown,
): ChatNotificationMode | null {
  return typeof input === "string" &&
    CHAT_NOTIFICATION_MODES.includes(input as ChatNotificationMode)
    ? (input as ChatNotificationMode)
    : null;
}

export function parseBrowserPushSubscription(
  input: unknown,
):
  | { ok: true; value: BrowserPushSubscriptionInput }
  | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "A push subscription is required" };
  }
  const candidate = input as Record<string, unknown>;
  const keys =
    candidate.keys &&
    typeof candidate.keys === "object" &&
    !Array.isArray(candidate.keys)
      ? (candidate.keys as Record<string, unknown>)
      : null;
  const endpoint =
    typeof candidate.endpoint === "string" ? candidate.endpoint.trim() : "";
  const p256dh = typeof keys?.p256dh === "string" ? keys.p256dh.trim() : "";
  const auth = typeof keys?.auth === "string" ? keys.auth.trim() : "";
  const expirationTime =
    candidate.expirationTime === null ||
    candidate.expirationTime === undefined
      ? null
      : typeof candidate.expirationTime === "number" &&
          Number.isSafeInteger(candidate.expirationTime) &&
          candidate.expirationTime > 0
        ? candidate.expirationTime
        : Number.NaN;

  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    return { ok: false, error: "The push endpoint is invalid" };
  }
  if (
    parsedEndpoint.protocol !== "https:" ||
    endpoint.length < 16 ||
    endpoint.length > 2048 ||
    parsedEndpoint.username ||
    parsedEndpoint.password ||
    unsafeEndpointHostname(parsedEndpoint.hostname)
  ) {
    return {
      ok: false,
      error: "The push endpoint must be a valid public HTTPS URL",
    };
  }
  if (
    p256dh.length < 16 ||
    p256dh.length > 512 ||
    !BASE64URL_PATTERN.test(p256dh)
  ) {
    return { ok: false, error: "The push subscription key is invalid" };
  }
  if (
    auth.length < 8 ||
    auth.length > 256 ||
    !BASE64URL_PATTERN.test(auth)
  ) {
    return { ok: false, error: "The push authentication key is invalid" };
  }
  if (Number.isNaN(expirationTime)) {
    return { ok: false, error: "The push subscription expiration is invalid" };
  }

  return {
    ok: true,
    value: {
      endpoint,
      expirationTime,
      keys: { p256dh, auth },
    },
  };
}

export function isSameOriginMutation(req: Request): boolean {
  const origin = req.headers.get("origin");
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return false;
  if (!origin) return process.env.NODE_ENV !== "production";
  try {
    return new URL(origin).origin === new URL(req.url).origin;
  } catch {
    return false;
  }
}

export function notificationExcerpt(content: string, maxLength = 180): string {
  const normalized = content
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

export function isMessageUnreadAtCursor(args: {
  messageCreatedAt: unknown;
  lastReadAt: unknown;
}): boolean {
  const messageTime =
    typeof args.messageCreatedAt === "string"
      ? Date.parse(args.messageCreatedAt)
      : Number.NaN;
  const readTime =
    typeof args.lastReadAt === "string"
      ? Date.parse(args.lastReadAt)
      : Number.NaN;
  if (!Number.isFinite(messageTime) || !Number.isFinite(readTime)) {
    return true;
  }
  return messageTime > readTime;
}

function mentionHandles(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .flatMap((value) => {
          const normalized = value?.trim().toLowerCase() || "";
          if (!normalized) return [];
          const local = normalized.includes("@")
            ? normalized.slice(0, normalized.indexOf("@"))
            : normalized;
          const compact = local.replace(/[^a-z0-9_-]+/g, "");
          const first = local.split(/[\s._-]+/)[0]?.replace(/[^a-z0-9_-]+/g, "");
          return [local, compact, first].filter(Boolean);
        }),
    ),
  );
}

export function messageMentionsRecipient(args: {
  content: string;
  email?: string | null;
  name?: string | null;
}): boolean {
  const content = args.content.toLowerCase();
  return mentionHandles([args.email, args.name]).some((handle) => {
    const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `(^|\\s)@${escaped}(?=\\s|[.,!?;:]|$)`,
      "i",
    ).test(content);
  });
}

export function pushTopicForChannel(channelId: string): string {
  return `chat-${channelId.replace(/-/g, "").slice(0, 27)}`;
}
