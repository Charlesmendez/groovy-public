const ATTACH_WITHOUT_SPACE = /^[,.;:!?)}\]]/u;
const MIN_COMPLETION_OVERLAP = 8;

function continuationOnly(body: string, completion: string): string {
  const suggestion = completion.trim();
  if (!suggestion || !body) return suggestion;
  if (suggestion.startsWith(body)) {
    return suggestion.slice(body.length).trimStart();
  }
  const maxOverlap = Math.min(body.length, suggestion.length);
  for (
    let overlap = maxOverlap;
    overlap >= MIN_COMPLETION_OVERLAP;
    overlap -= 1
  ) {
    if (body.slice(-overlap) === suggestion.slice(0, overlap)) {
      return suggestion.slice(overlap).trimStart();
    }
  }
  return suggestion;
}

export function emailCompletionSuffix(
  body: string,
  completion: string,
): string {
  const suggestion = continuationOnly(body, completion);
  if (!suggestion) return "";
  if (
    !body ||
    /\s$/u.test(body) ||
    ATTACH_WITHOUT_SPACE.test(suggestion)
  ) {
    return suggestion;
  }
  return ` ${suggestion}`;
}

export function acceptEmailCompletion(
  body: string,
  completion: string,
): string {
  return `${body}${emailCompletionSuffix(body, completion)}`;
}

export function classifyEmailCompletionResponse(args: {
  body: string;
  completion: string;
  status?: "suggestion" | "no_suggestion";
}): "suggestion" | "no_suggestion" {
  if (args.status === "no_suggestion") return "no_suggestion";
  return emailCompletionSuffix(args.body, args.completion)
    ? "suggestion"
    : "no_suggestion";
}

export function shouldRequestEmailCompletion(body: string): boolean {
  if (body.trim().length < 12) return false;
  const currentLine = body.split(/\r?\n/u).at(-1) || "";
  return Boolean(currentLine.trim());
}

export function isEmailCompletionCaretAtEnd({
  body,
  selectionStart,
  selectionEnd,
}: {
  body: string;
  selectionStart: number;
  selectionEnd: number;
}): boolean {
  return (
    selectionStart === body.length &&
    selectionEnd === body.length
  );
}

export function shouldScheduleEmailCompletion({
  body,
  bodyHtml,
  focused,
  selectionStart,
  selectionEnd,
}: {
  body: string;
  bodyHtml: string | null;
  focused: boolean;
  selectionStart: number;
  selectionEnd: number;
}): boolean {
  return (
    bodyHtml === null &&
    focused &&
    shouldRequestEmailCompletion(body) &&
    isEmailCompletionCaretAtEnd({ body, selectionStart, selectionEnd })
  );
}

export function canShowEmailCompletion({
  requestedBody,
  currentBody,
  selectionStart,
  selectionEnd,
}: {
  requestedBody: string;
  currentBody: string;
  selectionStart: number;
  selectionEnd: number;
}): boolean {
  return (
    requestedBody === currentBody &&
    isEmailCompletionCaretAtEnd({
      body: currentBody,
      selectionStart,
      selectionEnd,
    })
  );
}
