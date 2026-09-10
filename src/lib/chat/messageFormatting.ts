export type ChatInlineToken =
  | { type: "text"; value: string }
  | { type: "strong"; value: string }
  | { type: "italic"; value: string }
  | { type: "underline"; value: string }
  | { type: "strike"; value: string }
  | { type: "code"; value: string }
  | { type: "link"; label: string; href: string };

const INLINE_TOKEN_PATTERN =
  /(`[^`\n]+`|\*\*[^*\n]+?\*\*|__[^_\n]+?__|~~[^~\n]+?~~|(?<!\w)_[^_\n]+?_(?!\w)|(?<!\*)\*[^*\n]+?\*(?!\*)|\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^\s)\n]+\)|https?:\/\/[^\s<>"']+)/gi;

const TRAILING_BARE_URL_PUNCTUATION = /[.,;:!?]/;

type BareHttpLink = {
  token: Extract<ChatInlineToken, { type: "link" }>;
  suffix: string;
};

function hasMoreClosingThanOpening(value: string, open: string, close: string) {
  let opening = 0;
  let closing = 0;
  for (const character of value) {
    if (character === open) opening += 1;
    if (character === close) closing += 1;
  }
  return closing > opening;
}

function safeHttpHref(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function bareHttpLinkToken(raw: string): BareHttpLink | null {
  let value = raw;
  let suffix = "";

  while (value.length > 0) {
    const last = value[value.length - 1] || "";
    if (TRAILING_BARE_URL_PUNCTUATION.test(last)) {
      suffix = last + suffix;
      value = value.slice(0, -1);
      continue;
    }
    if (
      (last === ")" && hasMoreClosingThanOpening(value, "(", ")")) ||
      (last === "]" && hasMoreClosingThanOpening(value, "[", "]")) ||
      (last === "}" && hasMoreClosingThanOpening(value, "{", "}"))
    ) {
      suffix = last + suffix;
      value = value.slice(0, -1);
      continue;
    }
    break;
  }

  const href = safeHttpHref(value);
  if (!href) return null;
  return { token: { type: "link", label: value, href }, suffix };
}

export function tokenizeChatInline(input: string): ChatInlineToken[] {
  const tokens: ChatInlineToken[] = [];
  let cursor = 0;

  for (const match of input.matchAll(INLINE_TOKEN_PATTERN)) {
    const raw = match[0];
    const index = match.index ?? 0;
    if (index > cursor) {
      tokens.push({ type: "text", value: input.slice(cursor, index) });
    }

    if (raw.startsWith("`")) {
      tokens.push({ type: "code", value: raw.slice(1, -1) });
    } else if (raw.startsWith("**")) {
      tokens.push({ type: "strong", value: raw.slice(2, -2) });
    } else if (raw.startsWith("__")) {
      tokens.push({ type: "underline", value: raw.slice(2, -2) });
    } else if (raw.startsWith("~~")) {
      tokens.push({ type: "strike", value: raw.slice(2, -2) });
    } else if (raw.startsWith("_") || raw.startsWith("*")) {
      tokens.push({ type: "italic", value: raw.slice(1, -1) });
    } else if (/^https?:\/\//i.test(raw)) {
      const link = bareHttpLinkToken(raw);
      if (link) {
        tokens.push(link.token);
        if (link.suffix) tokens.push({ type: "text", value: link.suffix });
      } else {
        tokens.push({ type: "text", value: raw });
      }
    } else {
      const link = raw.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      tokens.push(
        link
          ? { type: "link", label: link[1], href: link[2] }
          : { type: "text", value: raw },
      );
    }
    cursor = index + raw.length;
  }

  if (cursor < input.length) {
    tokens.push({ type: "text", value: input.slice(cursor) });
  }

  return tokens.length > 0 ? tokens : [{ type: "text", value: input }];
}

export function toPlainChatPreview(input: string): string {
  return input
    .replace(/```[^\n`]*\n([\s\S]*?)```/g, "$1")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^)]+\)/gi, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s+)?/gm, "")
    .trim();
}
