export const MAX_CHAT_SNIPPET_BYTES = 200_000;
export const MAX_CHAT_SNIPPET_TITLE_LENGTH = 120;
export const MAX_CHAT_SNIPPET_LANGUAGE_LENGTH = 40;

export type ChatTextSnippet = {
  title: string;
  content: string;
  language: string | null;
  sizeBytes: number;
  kind: "snippet" | "canvas";
};

export class ChatSnippetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatSnippetValidationError";
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function validateChatTextSnippet(value: unknown): ChatTextSnippet | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChatSnippetValidationError("The text snippet is invalid.");
  }
  const input = value as Record<string, unknown>;
  const content = typeof input.content === "string" ? input.content : "";
  if (!content.trim()) {
    throw new ChatSnippetValidationError("Add some text to the snippet.");
  }
  const sizeBytes = utf8ByteLength(content);
  if (sizeBytes > MAX_CHAT_SNIPPET_BYTES) {
    throw new ChatSnippetValidationError(
      "Text snippets must be 200 KB or smaller.",
    );
  }
  const title =
    typeof input.title === "string"
      ? input.title.replace(/[\r\n\t]+/g, " ").trim()
      : "";
  if (title.length > MAX_CHAT_SNIPPET_TITLE_LENGTH) {
    throw new ChatSnippetValidationError(
      `Snippet titles must be ${MAX_CHAT_SNIPPET_TITLE_LENGTH} characters or shorter.`,
    );
  }
  const rawLanguage =
    typeof input.language === "string" ? input.language.trim() : "";
  if (
    rawLanguage.length > MAX_CHAT_SNIPPET_LANGUAGE_LENGTH ||
    (rawLanguage && !/^[a-z0-9+#._-]+$/i.test(rawLanguage))
  ) {
    throw new ChatSnippetValidationError("The snippet language is invalid.");
  }
  const kind = input.kind === "canvas" ? "canvas" : "snippet";
  return {
    title: title || (kind === "canvas" ? "Untitled canvas" : "Text snippet"),
    content,
    language: rawLanguage || null,
    sizeBytes,
    kind,
  };
}

export function messageTextSnippet(
  metadata: Record<string, unknown> | null | undefined,
): ChatTextSnippet | null {
  try {
    return validateChatTextSnippet(metadata?.snippet);
  } catch {
    return null;
  }
}

export function textSnippetMessage(snippet: ChatTextSnippet): string {
  return snippet.kind === "canvas"
    ? `Shared a canvas: ${snippet.title}`
    : `Shared a text snippet: ${snippet.title}`;
}
