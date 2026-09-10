export const EMAIL_CLASSIFICATION_ROUTING_CONFIDENCE = 0.8;
export const EMAIL_AUTO_ARCHIVE_CONFIDENCE = 0.88;
export const EMAIL_AUTO_SPAM_CONFIDENCE = 0.93;

export type EmailClassificationRoute =
  | "focus"
  | "needs_review"
  | "noise"
  | "handled";

type ClassificationArgs = {
  action?: string | null;
  status?: string | null;
  confidence?: number | null;
  override?: string | null;
  critical?: boolean;
};

function confidence(value: number | null | undefined): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

export function routeEmailClassification(
  args: ClassificationArgs,
): EmailClassificationRoute {
  if (args.override === "focus") return "focus";
  if (args.override === "inbox") return "needs_review";
  if (args.override === "noise") return "noise";
  if (args.override === "handled") return "handled";

  if (args.status === "failed" || args.status === "rejected") {
    return "needs_review";
  }
  // Workspace routing and Gmail mutation approval are separate decisions.
  // Archive recommendations remain in Needs Review because they are
  // legitimate mail awaiting a filing choice. Confident spam/unsubscribe
  // classifications belong in Noise immediately even when their destructive
  // Gmail action is still pending approval.
  if (args.status === "pending" && args.action === "archive") {
    return "needs_review";
  }
  const score = confidence(args.confidence);
  if (
    (args.action === "mark_spam" || args.action === "unsubscribe") &&
    (args.status === "done" ||
      score >= EMAIL_CLASSIFICATION_ROUTING_CONFIDENCE)
  ) {
    return "noise";
  }
  // Applying Groovy's processed label is bookkeeping, not completion of the
  // user's task. A high-confidence label-only classification can represent an
  // external action such as reviewing or signing a contract, so it must keep
  // its normal Focus/Needs Review routing after the label mutation succeeds.
  if (args.status === "done" && args.action !== "label_only") {
    return "handled";
  }
  if (score < EMAIL_CLASSIFICATION_ROUTING_CONFIDENCE) {
    return "needs_review";
  }
  // "Critical" describes urgency, not classifier uncertainty. A confident
  // important email belongs in Focus; only low confidence should send it to
  // Needs Review.
  // A pending archive is a high-confidence classification but still needs
  // approval until it clears the stricter Gmail mutation threshold.
  if (args.action === "archive") return "needs_review";
  return "focus";
}

export function shouldAutoExecuteEmailAction(args: {
  action: string;
  requested: boolean;
  confidence: number | null | undefined;
}): boolean {
  if (!args.requested) return false;
  const score = confidence(args.confidence);
  if (args.action === "draft_reply" || args.action === "unsubscribe") {
    return false;
  }
  if (args.action === "mark_spam") {
    return score >= EMAIL_AUTO_SPAM_CONFIDENCE;
  }
  if (args.action === "archive") {
    return score >= EMAIL_AUTO_ARCHIVE_CONFIDENCE;
  }
  return args.action === "label_only";
}
