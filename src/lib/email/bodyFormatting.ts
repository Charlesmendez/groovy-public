export type EmailBodyToken =
  | { type: "text"; value: string }
  | { type: "link"; label: string; href: string };

export type EmailBodySections = {
  visible: string;
  quoted: string | null;
};

const EMAIL_LINK_PATTERN =
  /<((?:https?:\/\/|mailto:)[^<>\s]+)>|\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)\n]+)\)|((?:https?:\/\/)[^\s<>"']+)/gi;

function splitBareUrlTail(value: string): { href: string; tail: string } {
  let end = value.length;

  while (end > 0 && /[.,!?;:]/.test(value[end - 1])) end -= 1;

  const pairs = [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ] as const;
  let changed = true;
  while (changed && end > 0) {
    changed = false;
    for (const [open, close] of pairs) {
      if (value[end - 1] !== close) continue;
      const candidate = value.slice(0, end);
      const openCount = candidate.split(open).length - 1;
      const closeCount = candidate.split(close).length - 1;
      if (closeCount > openCount) {
        end -= 1;
        changed = true;
      }
    }
  }

  return {
    href: value.slice(0, end),
    tail: value.slice(end),
  };
}

export function splitEmailBodyHistory(input: string): EmailBodySections {
  const body = input.replace(/\r\n?/g, "\n").trim();
  if (!body) return { visible: "", quoted: null };

  const separators = [
    /\nOn [^\n]{1,320} wrote:\s*\n/i,
    /\nEl [^\n]{1,320} (?:escribió|escribio):\s*\n/i,
    /\n-{2,}\s*Original Message\s*-{2,}/i,
    /\n(?:From|De):\s*[^\n]+\n(?:Sent|Date|Enviado|Fecha):\s*[^\n]+(?:\n(?:To|Para|Cc|Subject|Asunto):\s*[^\n]+){1,4}/i,
    /\n(?:>[^\n]*(?:\n|$)){2,}/m,
    /\n-{5,}\s*Forwarded message\s*-{5,}/i,
  ];
  let splitAt = -1;
  for (const pattern of separators) {
    const match = pattern.exec(body);
    if (!match || match.index < 20) continue;
    if (splitAt === -1 || match.index < splitAt) splitAt = match.index;
  }
  if (splitAt === -1) return { visible: body, quoted: null };

  const visible = body.slice(0, splitAt).trim();
  const quoted = body.slice(splitAt).trim();
  return visible && quoted
    ? { visible, quoted }
    : { visible: body, quoted: null };
}

export function tokenizeEmailBody(input: string): EmailBodyToken[] {
  const tokens: EmailBodyToken[] = [];
  let cursor = 0;

  for (const match of input.matchAll(EMAIL_LINK_PATTERN)) {
    const raw = match[0];
    const index = match.index ?? 0;
    if (index > cursor) {
      tokens.push({ type: "text", value: input.slice(cursor, index) });
    }

    const angleUrl = match[1];
    const markdownLabel = match[2];
    const markdownUrl = match[3];
    const bareUrl = match[4];

    if (angleUrl) {
      tokens.push({ type: "link", label: angleUrl, href: angleUrl });
    } else if (markdownLabel && markdownUrl) {
      tokens.push({
        type: "link",
        label: markdownLabel,
        href: markdownUrl,
      });
    } else if (bareUrl) {
      const { href, tail } = splitBareUrlTail(bareUrl);
      tokens.push({ type: "link", label: href, href });
      if (tail) tokens.push({ type: "text", value: tail });
    } else {
      tokens.push({ type: "text", value: raw });
    }

    cursor = index + raw.length;
  }

  if (cursor < input.length) {
    tokens.push({ type: "text", value: input.slice(cursor) });
  }

  return tokens.length > 0 ? tokens : [{ type: "text", value: input }];
}
