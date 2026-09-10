export type ChatComposerFormat =
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "link"
  | "ordered-list"
  | "bullet-list"
  | "checklist"
  | "quote"
  | "inline-code"
  | "code-block";

export type ChatComposerSelection = {
  value: string;
  selectionStart: number;
  selectionEnd: number;
};

export type ChatComposerFormatResult = ChatComposerSelection;

function wrappedSelection(
  input: ChatComposerSelection,
  before: string,
  after: string,
  placeholder: string,
): ChatComposerFormatResult {
  const selected = input.value.slice(input.selectionStart, input.selectionEnd);
  const content = selected || placeholder;
  const replacement = `${before}${content}${after}`;
  const value =
    input.value.slice(0, input.selectionStart) +
    replacement +
    input.value.slice(input.selectionEnd);
  const start = input.selectionStart + before.length;
  return {
    value,
    selectionStart: start,
    selectionEnd: start + content.length,
  };
}

function prefixSelectedLines(
  input: ChatComposerSelection,
  prefixForIndex: (index: number) => string,
): ChatComposerFormatResult {
  const lineStart = input.value.lastIndexOf("\n", input.selectionStart - 1) + 1;
  const nextBreak = input.value.indexOf("\n", input.selectionEnd);
  const lineEnd = nextBreak === -1 ? input.value.length : nextBreak;
  const selected = input.value.slice(lineStart, lineEnd) || "List item";
  const replacement = selected
    .split("\n")
    .map((line, index) => `${prefixForIndex(index)}${line}`)
    .join("\n");
  return {
    value:
      input.value.slice(0, lineStart) +
      replacement +
      input.value.slice(lineEnd),
    selectionStart: lineStart,
    selectionEnd: lineStart + replacement.length,
  };
}

export function applyChatComposerFormat(
  input: ChatComposerSelection,
  format: ChatComposerFormat,
  options: { href?: string } = {},
): ChatComposerFormatResult {
  if (format === "bold") return wrappedSelection(input, "**", "**", "bold");
  if (format === "italic") return wrappedSelection(input, "_", "_", "italic");
  if (format === "underline") {
    return wrappedSelection(input, "__", "__", "underlined");
  }
  if (format === "strike") {
    return wrappedSelection(input, "~~", "~~", "strikethrough");
  }
  if (format === "inline-code") {
    return wrappedSelection(input, "`", "`", "code");
  }
  if (format === "code-block") {
    return wrappedSelection(input, "```\n", "\n```", "code");
  }
  if (format === "link") {
    const href = options.href?.trim() || "https://";
    return wrappedSelection(input, "[", `](${href})`, "link text");
  }
  if (format === "ordered-list") {
    return prefixSelectedLines(input, (index) => `${index + 1}. `);
  }
  if (format === "bullet-list") {
    return prefixSelectedLines(input, () => "- ");
  }
  if (format === "checklist") {
    return prefixSelectedLines(input, () => "- [ ] ");
  }
  return prefixSelectedLines(input, () => "> ");
}
