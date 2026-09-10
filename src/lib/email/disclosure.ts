export const GROOVY_AI_EMAIL_DISCLOSURE =
  "Sent via Groovy with AI. I apologize in advance for any unintended messages.";

const LEGACY_GROOVY_AI_EMAIL_DISCLOSURES = [
  "Sent with Groovy AI assistant. I apologize for any unintended messages.",
  "Email sent via my Groovy assistant. Please excuse any unintended requests.",
] as const;

const ALL_GROOVY_AI_EMAIL_DISCLOSURES = [
  GROOVY_AI_EMAIL_DISCLOSURE,
  ...LEGACY_GROOVY_AI_EMAIL_DISCLOSURES,
] as const;

function stripOneTrailingDisclosure(body: string, disclosure: string): string {
  const trimmed = body.trimEnd();
  if (!trimmed.toLowerCase().endsWith(disclosure.toLowerCase())) {
    return body;
  }
  return trimmed
    .slice(0, -disclosure.length)
    .trimEnd()
    .replace(/\n[ \t]*(?:—|--)[ \t]*$/u, "")
    .trimEnd();
}

export function stripGroovyAiEmailDisclosure(body: string): string {
  let cleaned = body;
  let previous = "";
  while (cleaned !== previous) {
    previous = cleaned;
    for (const disclosure of ALL_GROOVY_AI_EMAIL_DISCLOSURES) {
      cleaned = stripOneTrailingDisclosure(cleaned, disclosure);
    }
  }
  return cleaned.trimEnd();
}

export function ensureGroovyAiEmailDisclosure(body: string): string {
  const message = stripGroovyAiEmailDisclosure(body);
  return message
    ? `${message}\n\n—\n${GROOVY_AI_EMAIL_DISCLOSURE}`
    : GROOVY_AI_EMAIL_DISCLOSURE;
}
