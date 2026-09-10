export type EmailTriageIdentity = {
  connectionId: string;
  id: string;
};

export type ExistingEmailActionIdentity = {
  connection_id?: unknown;
  gmail_message_id?: unknown;
  recommended_action?: unknown;
  status?: unknown;
  reason?: unknown;
  metadata?: unknown;
};

type RecordLike = Record<string, unknown>;

export const ACTIVE_DRAFT_REPLY_STATUSES = [
  "pending",
  "approved",
  "executing",
] as const;

export const EMAIL_TRIAGE_SUPERSEDED_REASON =
  "Superseded by the current email triage policy.";

export const EMAIL_TRIAGE_MODEL_FAILURE_SOURCE = "model_failure";

export function emailActionIsRetryableModelFailure(
  row: ExistingEmailActionIdentity,
): boolean {
  const metadata = record(row.metadata);
  return (
    text(metadata?.triage_decision_source) ===
      EMAIL_TRIAGE_MODEL_FAILURE_SOURCE &&
    !text(metadata?.email_workspace_override_view)
  );
}

function modelFailureRetryIsDue(row: ExistingEmailActionIdentity): boolean {
  const metadata = record(row.metadata);
  const retryAfter = Date.parse(text(metadata?.triage_retry_after));
  return !Number.isFinite(retryAfter) || retryAfter <= Date.now();
}

export function draftReplyActionBlocksNewMessage(status: string): boolean {
  return (ACTIVE_DRAFT_REPLY_STATUSES as readonly string[]).includes(status);
}

export function shouldReleaseDraftReplyThreadClaim(args: {
  status: string;
  existingMessageId: string;
  incomingMessageId: string;
}): boolean {
  return (
    args.existingMessageId.trim() !== args.incomingMessageId.trim() &&
    !draftReplyActionBlocksNewMessage(args.status)
  );
}

export function gmailTriageInboxQuery(lookbackDays = 7): string {
  const normalizedDays = Number.isFinite(lookbackDays)
    ? Math.max(1, Math.min(30, Math.floor(lookbackDays)))
    : 7;
  return `in:inbox -from:me newer_than:${normalizedDays}d`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function identityKey(connectionId: string, messageId: string): string {
  return `${connectionId.trim()}:${messageId.trim()}`;
}

function record(value: unknown): RecordLike | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : null;
}

export function emailActionNeedsPolicyRefresh(
  row: ExistingEmailActionIdentity,
  currentPolicyVersion: number,
): boolean {
  const status = text(row.status);
  const action = text(row.recommended_action);
  const supersededClassification =
    status === "rejected" &&
    text(row.reason) === EMAIL_TRIAGE_SUPERSEDED_REASON;
  if (
    status !== "pending" &&
    !(status === "done" && action === "label_only") &&
    !supersededClassification
  ) {
    return false;
  }
  if (action === "draft_reply") return false;
  const metadata = record(row.metadata);
  if (text(metadata?.email_workspace_override_view)) return false;
  if (
    emailActionIsRetryableModelFailure(row) &&
    modelFailureRetryIsDue(row)
  ) {
    return true;
  }
  const version = Number(metadata?.triage_policy_version || 0);
  return !Number.isFinite(version) || version < currentPolicyVersion;
}

export function filterUnorganizedEmails<T extends EmailTriageIdentity>(
  emails: T[],
  existingActions: ExistingEmailActionIdentity[],
  options?: { currentPolicyVersion?: number },
): T[] {
  const currentPolicyVersion = Number(options?.currentPolicyVersion || 0);
  const organized = new Set(
    existingActions
      .filter(
        (row) =>
          currentPolicyVersion <= 0 ||
          !emailActionNeedsPolicyRefresh(row, currentPolicyVersion),
      )
      .map((row) =>
        identityKey(text(row.connection_id), text(row.gmail_message_id)),
      )
      .filter((key) => key !== ":"),
  );
  return emails.filter(
    (email) => !organized.has(identityKey(email.connectionId, email.id)),
  );
}

export function interleaveEmailTriageCandidates<T>(
  groups: readonly (readonly T[])[],
): T[] {
  const output: T[] = [];
  const maxLength = groups.reduce(
    (max, group) => Math.max(max, group.length),
    0,
  );
  for (let index = 0; index < maxLength; index += 1) {
    for (const group of groups) {
      if (index < group.length) output.push(group[index]);
    }
  }
  return output;
}

export function shouldSupersedeEmailClassification(args: {
  candidateId: string;
  candidateDecisionAt: string;
  candidatePolicyVersion: number;
  currentId: string;
  currentDecisionAt: string;
  currentPolicyVersion: number;
}): boolean {
  if (!Number.isFinite(args.candidatePolicyVersion)) return true;
  if (args.candidatePolicyVersion < args.currentPolicyVersion) return true;
  if (args.candidatePolicyVersion > args.currentPolicyVersion) return false;

  const candidateDecisionAt = Date.parse(args.candidateDecisionAt);
  const currentDecisionAt = Date.parse(args.currentDecisionAt);
  if (
    Number.isFinite(candidateDecisionAt) &&
    Number.isFinite(currentDecisionAt) &&
    candidateDecisionAt !== currentDecisionAt
  ) {
    return candidateDecisionAt < currentDecisionAt;
  }

  // Postgres UUIDs and timestamps provide a stable tie-break so concurrent
  // triage runs cannot reject each other and leave no pending classification.
  return args.candidateId.localeCompare(args.currentId) < 0;
}
