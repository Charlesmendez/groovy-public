/**
 * Lightweight, allowlist-based HTML sanitizer for agent-emitted canvas markup.
 *
 * Defense in depth: the iframe runs with `sandbox="allow-forms allow-same-origin"`
 * (no scripts), the initial srcDoc gets a CSP meta tag, and the turn response
 * carries a strict CSP header. This sanitizer ensures persisted HTML can never
 * carry executable hostile markup even if the browser sandbox is bypassed, and
 * prevents the agent from embedding off-origin form posts or external resource
 * loads.
 */

type SanitizeRule = {
  tag: string;
  pattern: RegExp;
  replacement: string | ((match: string, ...groups: string[]) => string);
};

const RULES: ReadonlyArray<SanitizeRule> = [
  { tag: "script", pattern: /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, replacement: "" },
  { tag: "script-open", pattern: /<script\b[^>]*>/gi, replacement: "" },
  {
    tag: "forbidden-element",
    pattern: /<\s*\/?\s*(iframe|object|embed|applet|frame|frameset|base)\b[^>]*>/gi,
    replacement: "",
  },
  {
    tag: "link-element",
    pattern: /<link\b[^>]*>/gi,
    replacement: "",
  },
  { tag: "inline-event-handler", pattern: /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, replacement: "" },
  { tag: "srcset", pattern: /\s+srcset\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, replacement: "" },
  {
    tag: "javascript-url",
    pattern: /\s+(href|src|action|formaction)\s*=\s*(["'])\s*javascript:[^"']*\2/gi,
    replacement: (_, attr: string, quote: string) => ` ${attr}=${quote}#${quote}`,
  },
  {
    tag: "data-html-url",
    pattern: /\s+(href|src)\s*=\s*(["'])\s*data:text\/html[^"']*\2/gi,
    replacement: (_, attr: string, quote: string) => ` ${attr}=${quote}#${quote}`,
  },
  {
    tag: "escape-target",
    pattern: /\s+target\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
    replacement: ' target="_self"',
  },
  { tag: "css-import", pattern: /@import\b[^;]*;?/gi, replacement: "" },
];

const URL_ATTR_PATTERN =
  /(<([a-z][\w:-]*)\b[^>]*?)\s+(action|formaction|href|src|poster|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;
const META_TAG_PATTERN = /<meta\b[^>]*>/gi;

export type SanitizeResult = {
  html: string;
  removed: string[];
};

export function sanitizeCanvasHtml(input: string): SanitizeResult {
  const removed: string[] = [];
  let html = input;

  for (const { tag, pattern, replacement } of RULES) {
    const next =
      typeof replacement === "string"
        ? html.replace(pattern, replacement)
        : html.replace(pattern, replacement);
    if (next !== html) {
      removed.push(tag);
      html = next;
    }
  }

  html = constrainMetaTags(html, removed);
  html = constrainUrlAttrs(html, removed);
  return { html, removed };
}

function constrainUrlAttrs(html: string, removed: string[]): string {
  return html.replace(URL_ATTR_PATTERN, (_match, tagPrefix: string, tagName: string, attr: string, doubleQuoted: string | undefined, singleQuoted: string | undefined, unquoted: string | undefined) => {
    const value = doubleQuoted ?? singleQuoted ?? unquoted ?? "";
    if (isAllowedUrl(value, tagName.toLowerCase(), attr.toLowerCase())) {
      return `${tagPrefix} ${attr}="${escapeAttr(value)}"`;
    }
    removed.push(`off-origin-${attr.toLowerCase()}`);
    return `${tagPrefix} ${attr}="#"`;
  });
}

function constrainMetaTags(html: string, removed: string[]): string {
  return html.replace(META_TAG_PATTERN, (tag) => {
    if (isAllowedMetaTag(tag)) return tag;
    removed.push("forbidden-meta");
    return "";
  });
}

function isAllowedMetaTag(tag: string): boolean {
  if (/\shttp-equiv\s*=/i.test(tag)) return false;
  if (/\scharset\s*=/i.test(tag)) return true;
  return /\sname\s*=\s*(?:"viewport"|'viewport'|viewport)(?:\s|>|\/)/i.test(tag);
}

function isAllowedUrl(value: string, tagName: string, attr: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("#")) return true;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return true;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("https://") && tagName === "img" && attr === "src") return true;
  if (lower.startsWith("data:image/") && tagName === "img" && attr === "src") return true;
  if (!/^[a-z][a-z0-9+.-]*:/.test(lower) && !trimmed.startsWith("//")) return true;
  return false;
}

export function injectCanvasCspMeta(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(CANVAS_CSP_HEADER)}">`;
  if (/<meta\b[^>]*\shttp-equiv\s*=\s*(?:"content-security-policy"|'content-security-policy'|content-security-policy)/i.test(html)) {
    return html;
  }
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (match) => `${match}\n${meta}`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b[^>]*>/i, (match) => `${match}\n<head>\n${meta}\n</head>`);
  }
  return `${meta}\n${html}`;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export const CANVAS_CSP_HEADER =
  "default-src 'none'; " +
  "style-src 'unsafe-inline'; " +
  "img-src data: https:; " +
  "font-src 'self' data:; " +
  "form-action 'self'; " +
  "base-uri 'none'; " +
  "frame-ancestors 'self'";
