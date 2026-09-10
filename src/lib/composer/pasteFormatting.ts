type ListState = {
  ordered: boolean;
  next: number;
};

const HTML_ENTITY_VALUES: Record<string, string> = {
  amp: "&",
  apos: "'",
  bull: "•",
  gt: ">",
  hellip: "…",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  mdash: "—",
  nbsp: " ",
  ndash: "–",
  quot: '"',
  rdquo: "”",
  rsquo: "’",
};

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi,
    (entity, raw: string) => {
      if (raw[0] !== "#") {
        return HTML_ENTITY_VALUES[raw.toLowerCase()] ?? entity;
      }
      const hexadecimal = raw[1]?.toLowerCase() === "x";
      const codePoint = Number.parseInt(
        raw.slice(hexadecimal ? 2 : 1),
        hexadecimal ? 16 : 10,
      );
      if (!Number.isFinite(codePoint) || codePoint <= 0) return entity;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return entity;
      }
    },
  );
}

function listStart(tag: string): number {
  const match = tag.match(/\bstart\s*=\s*(?:["'](\d+)["']|(\d+))/i);
  const parsed = Number.parseInt(match?.[1] || match?.[2] || "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function structuredTextFromListHtml(html: string): string | null {
  if (!/<(?:ul|ol|li)\b/i.test(html)) return null;

  const safeHtml = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, "");
  const tokens = safeHtml.match(/<[^>]+>|[^<]+/g) || [];
  const lists: ListState[] = [];
  let openListItems = 0;
  let output = "";

  const newline = () => {
    output = output.replace(/[ \t]+$/g, "");
    if (output && !output.endsWith("\n")) output += "\n";
  };
  const appendText = (raw: string) => {
    const decoded = decodeHtmlEntities(raw);
    const normalized = decoded.replace(/\s+/g, " ");
    const content = normalized.trim();
    if (!content) return;
    const needsSpace =
      /^\s/.test(normalized) &&
      Boolean(output) &&
      !/[\s\n]$/.test(output);
    if (needsSpace) output += " ";
    output += content;
    if (/\s$/.test(normalized)) output += " ";
  };

  for (const token of tokens) {
    if (!token.startsWith("<")) {
      appendText(token);
      continue;
    }
    const match = token.match(/^<\s*(\/?)\s*([a-z0-9]+)/i);
    if (!match) continue;
    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();

    if (!closing && (tag === "ul" || tag === "ol")) {
      newline();
      lists.push({ ordered: tag === "ol", next: listStart(token) });
      continue;
    }
    if (closing && (tag === "ul" || tag === "ol")) {
      lists.pop();
      newline();
      continue;
    }
    if (!closing && tag === "li") {
      newline();
      const list = lists[lists.length - 1] || { ordered: false, next: 1 };
      const marker = list.ordered ? `${list.next}. ` : "- ";
      if (list.ordered) list.next += 1;
      output += `${"  ".repeat(Math.max(0, lists.length - 1))}${marker}`;
      openListItems += 1;
      continue;
    }
    if (closing && tag === "li") {
      newline();
      openListItems = Math.max(0, openListItems - 1);
      continue;
    }
    if (tag === "br") {
      newline();
      continue;
    }
    if (
      ["div", "p", "h1", "h2", "h3", "h4", "h5", "h6"].includes(tag) &&
      (openListItems === 0 || closing)
    ) {
      newline();
    }
  }

  const result = output
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return result || null;
}

export function pasteTextPreservingStructure(args: {
  html: string;
  text: string;
}): string {
  return structuredTextFromListHtml(args.html) || args.text;
}

export function insertTextAtSelection(args: {
  value: string;
  insertion: string;
  selectionStart: number | null;
  selectionEnd: number | null;
}): { value: string; caret: number } {
  const start = Math.max(0, args.selectionStart ?? args.value.length);
  const end = Math.max(start, args.selectionEnd ?? start);
  const value =
    args.value.slice(0, start) + args.insertion + args.value.slice(end);
  return { value, caret: start + args.insertion.length };
}
