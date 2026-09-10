const COMPLETE_SUMMARY_PATTERN =
  /\b(daily trade summary|weekly summary|monthly summary|year-to-date|net today|sent scheduled whatsapp message)\b/i;

const INCOMPLETE_FINAL_PATTERNS = [
  /\b(?:task|job|work|extraction|browser(?:\s+extraction)?\s+task)\s+(?:is|has been|was)\s+queued\b/i,
  /\bqueued\s+(?:with|on|for)\s+(?:an?\s+)?(?:agent|worker|claude|codex|browser)\b/i,
  /\b(?:i(?:'|’)ll|i will|the agent will)\s+(?:complete|continue|finish|run|process)\b/i,
  /\b(now let me|let me now|let me check|i'?ll check|i will check|i'?ll retry|let me retry)\b/i,
  /\b(proceed with|proceed to|try a fresh approach|fresh query|simple query to reset)\b/i,
  /\b(session|connection).{0,80}\b(stuck|stale|error|keeps occurring|dead)\b/i,
  /\b(postgres|database).{0,120}\b(stuck|stale|error|retry|fresh approach)\b/i,
  /\bvalidation passed\b[\s\S]{0,800}\b(postgres|duplicates|insert|query)\b/i,
];

/**
 * Rejects planning/progress text that would otherwise consume a scheduled
 * occurrence as a successful final. Keep this aligned with the connector's
 * last-line reliability guard so cloud and connector runs behave identically.
 */
export function isIncompleteScheduledFinal(value: unknown): boolean {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || COMPLETE_SUMMARY_PATTERN.test(text)) return false;
  return INCOMPLETE_FINAL_PATTERNS.some((pattern) => pattern.test(text));
}
