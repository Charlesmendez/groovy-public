import type { EmailWorkspaceActionOperation } from "@/lib/email/actionState";

export type EmailClassificationCorrection = "focus" | "inbox" | "noise";

export function isEmailClassificationCorrection(
  value: unknown,
): value is EmailClassificationCorrection {
  return value === "focus" || value === "inbox" || value === "noise";
}

/**
 * Queue placement teaches future classification. Completing a conversation
 * does not: "Done" describes one thread's workflow state, not every future
 * message from the same sender.
 */
export function shouldRecordEmailClassificationFeedback(
  operation: EmailWorkspaceActionOperation,
): boolean {
  return (
    operation === "move_focus" ||
    operation === "move_inbox" ||
    operation === "move_noise"
  );
}
