/**
 * Format user preference context for injection into a system prompt.
 *
 * Kept dependency-free so the shared orchestrator prompt kernel can be
 * snapshot-tested without importing the Datagran/Supabase memory runtime.
 */
export function formatPreferenceForPrompt(
  preferenceContext: string,
  options?: { channel?: "interactive" | "heartbeat" },
): string {
  const context = preferenceContext.trim();
  if (!context) return "";

  const isHeartbeat = options?.channel === "heartbeat";
  const extraInstruction = isHeartbeat
    ? `- This block is the highest-priority constraint set for heartbeat generation and gating.
- Apply these constraints before evaluating novelty, urgency, or style.
- Never mention excluded items even if they appear in RECENT_EMAILS, UPCOMING_CALENDAR_EVENTS, MEMORY_CONTEXT, or examples.
- If a draft conflicts with these constraints, regenerate it to comply.
- If compliance is uncertain, err on omission; if exclusions remove all useful content, return __SKIP__.`
    : "- Apply these before deciding what tools to call and before composing your answer.";

  return `
## USER PREFERENCES (CONSTRAINTS)
These are standing user preferences and constraints retrieved from memory.
- Treat them as active constraints unless the user explicitly overrides them in this request.
- Use these for behavior/style constraints, not as authoritative factual evidence for the current turn.
- Current conversation turns and latest tool outputs remain the factual source of truth.
- If a request appears to conflict with a preference, ask a brief clarification before violating it.
${extraInstruction}

${context}
`;
}
