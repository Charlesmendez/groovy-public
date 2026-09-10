import katex from "katex";
import {
  tokenizeChatInline,
  type ChatInlineToken,
} from "@/lib/chat/messageFormatting";

type ChatMathDelimiter = {
  left: string;
  right: string;
  display: boolean;
  includeDelimiters?: boolean;
};

export type ChatMessageInlineToken =
  | ChatInlineToken
  | {
      type: "math";
      value: string;
      raw: string;
      display: boolean;
    };

const CHAT_MATH_DELIMITERS: ChatMathDelimiter[] = [
  { left: "$$", right: "$$", display: true },
  { left: "\\(", right: "\\)", display: false },
  {
    left: "\\begin{equation}",
    right: "\\end{equation}",
    display: true,
    includeDelimiters: true,
  },
  {
    left: "\\begin{align}",
    right: "\\end{align}",
    display: true,
    includeDelimiters: true,
  },
  {
    left: "\\begin{alignat}",
    right: "\\end{alignat}",
    display: true,
    includeDelimiters: true,
  },
  {
    left: "\\begin{gather}",
    right: "\\end{gather}",
    display: true,
    includeDelimiters: true,
  },
  {
    left: "\\begin{CD}",
    right: "\\end{CD}",
    display: true,
    includeDelimiters: true,
  },
  { left: "\\[", right: "\\]", display: true },
];

type ChatMathSegment =
  | { type: "text"; value: string }
  | {
      type: "math";
      value: string;
      raw: string;
      display: boolean;
    };

function findEndOfMath(
  delimiter: string,
  text: string,
  startIndex: number,
): number {
  let index = startIndex;
  let braceLevel = 0;

  while (index < text.length) {
    const character = text[index];
    if (
      braceLevel <= 0 &&
      text.slice(index, index + delimiter.length) === delimiter
    ) {
      return index;
    }
    if (character === "\\") {
      index += 1;
    } else if (character === "{") {
      braceLevel += 1;
    } else if (character === "}") {
      braceLevel -= 1;
    }
    index += 1;
  }

  return -1;
}

function nextInlineCodeSpan(input: string, startIndex: number) {
  const pattern = /`[^`\n]+`/g;
  pattern.lastIndex = startIndex;
  const match = pattern.exec(input);
  if (!match) return null;
  return {
    start: match.index,
    end: match.index + match[0].length,
  };
}

function nextMathDelimiter(input: string, startIndex: number) {
  let selected:
    | { index: number; delimiter: ChatMathDelimiter }
    | null = null;

  for (const delimiter of CHAT_MATH_DELIMITERS) {
    const index = input.indexOf(delimiter.left, startIndex);
    if (index === -1) continue;
    if (!selected || index < selected.index) {
      selected = { index, delimiter };
    }
  }

  return selected;
}

/**
 * Split chat text at the delimiters supported by KaTeX's auto-render defaults.
 * Inline code wins when it appears first, so formulas shown as code stay
 * literal. Fenced code is already separated by FormattedMessageContent.
 */
function splitChatMath(input: string): ChatMathSegment[] {
  const segments: ChatMathSegment[] = [];
  let cursor = 0;

  while (cursor < input.length) {
    const code = nextInlineCodeSpan(input, cursor);
    const math = nextMathDelimiter(input, cursor);

    if (!math) {
      segments.push({ type: "text", value: input.slice(cursor) });
      break;
    }

    if (code && code.start <= math.index) {
      segments.push({ type: "text", value: input.slice(cursor, code.end) });
      cursor = code.end;
      continue;
    }

    if (math.index > cursor) {
      segments.push({
        type: "text",
        value: input.slice(cursor, math.index),
      });
    }

    const expressionStart = math.index + math.delimiter.left.length;
    const expressionEnd = findEndOfMath(
      math.delimiter.right,
      input,
      expressionStart,
    );
    if (expressionEnd === -1) {
      segments.push({ type: "text", value: input.slice(math.index) });
      break;
    }

    const rawEnd = expressionEnd + math.delimiter.right.length;
    const raw = input.slice(math.index, rawEnd);
    segments.push({
      type: "math",
      value: math.delimiter.includeDelimiters
        ? raw
        : input.slice(expressionStart, expressionEnd),
      raw,
      display: math.delimiter.display,
    });
    cursor = rawEnd;
  }

  return segments.length > 0
    ? segments
    : [{ type: "text", value: input }];
}

export function tokenizeChatMessageInline(
  input: string,
): ChatMessageInlineToken[] {
  const tokens: ChatMessageInlineToken[] = [];
  const appendToken = (token: ChatMessageInlineToken) => {
    const previous = tokens[tokens.length - 1];
    if (previous?.type === "text" && token.type === "text") {
      previous.value += token.value;
      return;
    }
    tokens.push(token);
  };

  for (const segment of splitChatMath(input)) {
    if (segment.type === "math") {
      appendToken(segment);
    } else {
      tokenizeChatInline(segment.value).forEach(appendToken);
    }
  }
  return tokens;
}

export function renderChatMathToHtml(
  expression: string,
  displayMode: boolean,
): string | null {
  try {
    return katex.renderToString(expression, {
      displayMode,
      output: "htmlAndMathml",
      throwOnError: true,
      trust: false,
      maxExpand: 1_000,
      maxSize: 20,
    });
  } catch {
    return null;
  }
}
