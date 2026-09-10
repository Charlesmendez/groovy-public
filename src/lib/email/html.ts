import sanitizeHtml from "sanitize-html";

const SAFE_STYLE_VALUE =
  /^(?!.*(?:expression\s*\(|javascript\s*:|url\s*\(|@import|behavior\s*:|-moz-binding)).*$/i;

const SAFE_STYLE_PROPERTIES = [
  "background",
  "background-color",
  "border",
  "border-bottom",
  "border-bottom-color",
  "border-bottom-left-radius",
  "border-bottom-right-radius",
  "border-bottom-style",
  "border-bottom-width",
  "border-color",
  "border-left",
  "border-left-color",
  "border-left-style",
  "border-left-width",
  "border-radius",
  "border-right",
  "border-right-color",
  "border-right-style",
  "border-right-width",
  "border-style",
  "border-top",
  "border-top-color",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-top-style",
  "border-top-width",
  "border-width",
  "border-collapse",
  "border-spacing",
  "box-sizing",
  "color",
  "direction",
  "display",
  "font",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "height",
  "letter-spacing",
  "line-height",
  "margin",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "margin-top",
  "max-height",
  "max-width",
  "min-height",
  "overflow-wrap",
  "padding",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "text-align",
  "text-decoration",
  "text-indent",
  "text-shadow",
  "text-transform",
  "vertical-align",
  "white-space",
  "width",
  "word-break",
] as const;

const allowedStyles = {
  "*": Object.fromEntries(
    SAFE_STYLE_PROPERTIES.map((property) => [property, [SAFE_STYLE_VALUE]]),
  ),
};

function numericAttribute(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeEmailContentId(value: string): string {
  let normalized = value.trim().replace(/^cid:/i, "").trim();
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // A malformed percent escape should not prevent the rest of the email
    // from rendering. Gmail Content-ID values are otherwise opaque.
  }
  return normalized.replace(/^<|>$/g, "").trim().toLowerCase();
}

type SanitizeEmailHtmlOptions = {
  /**
   * Browser-safe URLs for MIME parts referenced by `cid:` image sources.
   * When supplied, unresolved CID images are removed instead of leaving a
   * permanently broken image placeholder in the reader.
   */
  cidImageSources?: ReadonlyMap<string, string>;
  /** Preserve embedded responsive CSS for sandboxed incoming-email display. */
  preserveDocumentStyles?: boolean;
};

/**
 * Sanitizes untrusted email HTML on the server. The allow-list intentionally
 * keeps the table and inline-style primitives used by transactional email
 * buttons while dropping executable content, forms, embedded pages, CSS URLs,
 * and direct UI-escaping positioning. Embedded styles are opt-in and must only
 * be rendered in the sandboxed email reader.
 */
export function sanitizeEmailHtml(
  input: string,
  options: SanitizeEmailHtmlOptions = {},
): string | null {
  const html = input.trim();
  if (!html) return null;

  const sanitized = sanitizeHtml(html, {
    // Sender styles are rendered only inside EmailBody's sandboxed iframe,
    // whose CSP disables scripts, forms, frames, objects, and external CSS.
    // Preserving embedded responsive CSS is necessary for real email layouts;
    // it is never injected directly into the application document.
    allowVulnerableTags: options.preserveDocumentStyles === true,
    allowedTags: [
      "a",
      "abbr",
      "address",
      "b",
      "blockquote",
      "body",
      "br",
      "caption",
      "center",
      "cite",
      "code",
      "col",
      "colgroup",
      "dd",
      "del",
      "div",
      "dl",
      "dt",
      "em",
      "font",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "hr",
      "i",
      "img",
      "kbd",
      "li",
      "ol",
      "p",
      "pre",
      "s",
      "small",
      "span",
      "strong",
      ...(options.preserveDocumentStyles ? ["style"] : []),
      "sub",
      "sup",
      "table",
      "tbody",
      "td",
      "tfoot",
      "th",
      "thead",
      "tr",
      "u",
      "ul",
    ],
    allowedAttributes: {
      "*": [
        "align",
        "bgcolor",
        "class",
        "dir",
        "height",
        "id",
        "lang",
        "role",
        "style",
        "title",
        "valign",
        "width",
      ],
      a: ["href", "name", "rel", "style", "target", "title"],
      blockquote: ["cite", "type"],
      img: [
        "alt",
        "decoding",
        "height",
        "loading",
        "referrerpolicy",
        "src",
        "style",
        "title",
        "width",
      ],
      table: [
        "align",
        "bgcolor",
        "border",
        "cellpadding",
        "cellspacing",
        "height",
        "role",
        "style",
        "width",
      ],
      td: [
        "align",
        "bgcolor",
        "colspan",
        "height",
        "rowspan",
        "style",
        "valign",
        "width",
      ],
      th: [
        "align",
        "bgcolor",
        "colspan",
        "height",
        "rowspan",
        "scope",
        "style",
        "valign",
        "width",
      ],
    },
    allowedSchemes: ["http", "https", "mailto", "cid", "data"],
    allowedSchemesByTag: {
      a: ["http", "https", "mailto"],
      img: ["http", "https", "cid", "data"],
    },
    allowedStyles,
    allowProtocolRelative: true,
    enforceHtmlBoundary: true,
    exclusiveFilter(frame) {
      if (frame.tag !== "img") return false;
      const src = frame.attribs.src || "";
      // Inline data URLs can contain megabytes of base64 data. Gmail already
      // exposes real inline MIME parts through authenticated attachment URLs;
      // echoing data URLs through a serverless response can exceed its payload
      // limit and prevents the conversation from opening at all.
      if (/^data:/i.test(src)) return true;
      if (/^cid:/i.test(src) && options.cidImageSources) {
        const contentId = normalizeEmailContentId(src);
        if (!options.cidImageSources.get(contentId)) return true;
      }
      const width = numericAttribute(frame.attribs.width);
      const height = numericAttribute(frame.attribs.height);
      return (width !== null && width <= 1) || (height !== null && height <= 1);
    },
    transformTags: {
      body: (_tagName, attribs) => ({
        tagName: "div",
        attribs,
      }),
      a: (_tagName, attribs) => ({
        tagName: "a",
        attribs: {
          ...attribs,
          target: "_blank",
          rel: "noopener noreferrer nofollow",
        },
      }),
      img: (_tagName, attribs) => {
        const src = attribs.src || "";
        const resolvedSrc =
          /^cid:/i.test(src) && options.cidImageSources
            ? options.cidImageSources.get(normalizeEmailContentId(src))
            : src;
        return {
          tagName: "img",
          attribs: {
            ...attribs,
            ...(resolvedSrc ? { src: resolvedSrc } : {}),
            alt: attribs.alt || "",
            decoding: "async",
            loading: "lazy",
            referrerpolicy: "no-referrer",
          },
        };
      },
    },
  }).trim();

  return sanitized || null;
}
