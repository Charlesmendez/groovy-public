export const EMAIL_TRIAGE_POLICY_VERSION = 2;

export type SemanticEmailKind =
  | "human"
  | "account"
  | "security"
  | "financial"
  | "transactional"
  | "calendar"
  | "bulk"
  | "cold_outreach"
  | "spam"
  | "unknown";

export type EvidenceBasedEmailAction =
  | "mark_spam"
  | "unsubscribe"
  | "label_only";

export type EvidenceBasedEmailDecision = {
  action: EvidenceBasedEmailAction;
  confidence: number;
  pImportant: number;
  pSpam: number;
  pActionable: number;
  reason: string;
  critical: boolean;
  autoExecute: false;
  signal:
    | "authenticated_operational"
    | "prior_correspondent"
    | "obvious_noise";
};

type EvidenceMergeableDecision = {
  messageKind: SemanticEmailKind;
  action:
    | "draft_reply"
    | "mark_spam"
    | "unsubscribe"
    | "archive"
    | "label_only";
  confidence: number;
  pImportant: number;
  pSpam: number;
  pActionable: number;
  reason: string;
  critical: boolean;
  autoExecute: boolean;
  draftReply?: string;
  targetThreadId?: string;
  targetMessageIdHeader?: string;
  targetReason?: string;
};

export type EmailTriageEvidenceInput = {
  senderEmail: string;
  senderDomain: string;
  to: string;
  cc: string;
  listUnsubscribe?: string;
  authenticationResults?: string;
  precedence?: string;
  listId?: string;
  gmailLabelIds?: string[];
  ownedAddresses?: string[];
  incomingCount?: number;
  repliedCount?: number;
  senderReputation?: "trusted" | "neutral" | "risky";
};

function normalize(value: string | undefined): string {
  return String(value || "").trim().toLowerCase();
}

function domainMatches(domain: string, root: string): boolean {
  return domain === root || domain.endsWith(`.${root}`);
}

function parseAddresses(value: string): string[] {
  return (
    value.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []
  ).map((address) => normalize(address));
}

function isDirectlyAddressed(input: EmailTriageEvidenceInput): boolean {
  const recipients = new Set(parseAddresses(`${input.to},${input.cc}`));
  return (input.ownedAddresses || [])
    .map(normalize)
    .filter(Boolean)
    .some((address) => recipients.has(address));
}

/**
 * Gmail adds its own Authentication-Results header. Requiring Google's result
 * plus aligned DMARC (or aligned DKIM as a fallback) prevents a display-name or
 * lookalike-domain sender from receiving trusted-service treatment.
 */
export function hasAlignedGmailAuthentication(args: {
  authenticationResults?: string;
  senderDomain: string;
}): boolean {
  const auth = normalize(args.authenticationResults);
  const senderDomain = normalize(args.senderDomain).replace(/^@/, "");
  if (!auth || !senderDomain || !/\bmx\.google\.com\b/.test(auth)) return false;

  const dmarcPass = /\bdmarc=pass\b/.test(auth);
  const headerFrom =
    auth.match(/\bheader\.from=([a-z0-9.-]+)/)?.[1]?.replace(/\.$/, "") || "";
  if (
    dmarcPass &&
    headerFrom &&
    (domainMatches(headerFrom, senderDomain) ||
      domainMatches(senderDomain, headerFrom))
  ) {
    return true;
  }

  const dkimDomains = Array.from(
    auth.matchAll(/\bdkim=pass\b[^;\r\n]*\bheader\.i=@([a-z0-9.-]+)/g),
    (match) => match[1].replace(/\.$/, ""),
  );
  return dkimDomains.some(
    (domain) =>
      domainMatches(domain, senderDomain) || domainMatches(senderDomain, domain),
  );
}

export function applyEmailTriageEvidence(
  input: EmailTriageEvidenceInput,
  semanticKind: SemanticEmailKind,
): EvidenceBasedEmailDecision | null {
  const senderDomain = normalize(input.senderDomain).replace(/^@/, "");
  const hasListUnsubscribe = Boolean(normalize(input.listUnsubscribe));
  const hasBulkEvidence =
    hasListUnsubscribe ||
    Boolean(normalize(input.listId)) ||
    /\b(bulk|list|junk)\b/i.test(input.precedence || "");
  const incomingCount = Math.max(0, Number(input.incomingCount || 0));
  const repliedCount = Math.max(0, Number(input.repliedCount || 0));
  const gmailLabels = new Set(
    (input.gmailLabelIds || []).map((label) => normalize(label).toUpperCase()),
  );
  const userTrustScore =
    (repliedCount > 0 ? 2 : 0) +
    (input.senderReputation === "trusted" ? 2 : 0) +
    (gmailLabels.has("STARRED") ? 2 : 0) +
    (gmailLabels.has("IMPORTANT") ? 1 : 0) +
    (incomingCount >= 3 ? 1 : 0);
  const gmailBulkCategory =
    gmailLabels.has("CATEGORY_PROMOTIONS") ||
    gmailLabels.has("CATEGORY_SOCIAL") ||
    gmailLabels.has("CATEGORY_FORUMS");
  const authenticated = hasAlignedGmailAuthentication({
    authenticationResults: input.authenticationResults,
    senderDomain,
  });

  // A direct person-to-person message from someone the user has already
  // emailed is part of an established conversation. Keep that relationship
  // out of model-driven archive/spam decisions: quoted history can otherwise
  // make an incoming reply look like the user's own already-sent message.
  if (
    semanticKind === "human" &&
    repliedCount > 0 &&
    isDirectlyAddressed(input) &&
    !hasBulkEvidence &&
    !gmailBulkCategory
  ) {
    return {
      action: "label_only",
      confidence: 0.97,
      pImportant: 0.97,
      pSpam: 0.01,
      pActionable: 0.85,
      reason:
        "Direct human message from an established correspondent; keep it in Focus.",
      critical: false,
      autoExecute: false,
      signal: "prior_correspondent",
    };
  }

  if (
    (semanticKind === "account" ||
      semanticKind === "security" ||
      semanticKind === "financial" ||
      semanticKind === "transactional") &&
    authenticated &&
    isDirectlyAddressed(input) &&
    userTrustScore >= 2 &&
    !gmailBulkCategory
  ) {
    return {
      action: "label_only",
      confidence: 0.97,
      pImportant: 0.97,
      pSpam: 0.01,
      pActionable:
        semanticKind === "security" || semanticKind === "account" ? 0.9 : 0.76,
      reason: "Authenticated operational notice supported by user-specific trust signals.",
      critical: semanticKind === "security",
      autoExecute: false,
      signal: "authenticated_operational",
    };
  }

  const modelIdentifiedNoise =
    semanticKind === "spam" ||
    semanticKind === "bulk" ||
    semanticKind === "cold_outreach";
  const objectiveNoiseEvidence =
    hasBulkEvidence ||
    gmailBulkCategory ||
    input.senderReputation === "risky";
  if (repliedCount === 0 && modelIdentifiedNoise && objectiveNoiseEvidence) {
    const markSpam =
      semanticKind === "spam" &&
      (input.senderReputation === "risky" || !hasListUnsubscribe);
    return {
      action: markSpam ? "mark_spam" : "unsubscribe",
      confidence: markSpam ? 0.96 : 0.92,
      pImportant: 0.04,
      pSpam: markSpam ? 0.98 : 0.94,
      pActionable: 0.05,
      reason: markSpam
        ? "The model identified spam and objective sender signals support it."
        : "The model identified unwanted bulk mail and message headers support it.",
      critical: false,
      autoExecute: false,
      signal: "obvious_noise",
    };
  }

  // Ordinary personal and business mail remains model-routed. Deterministic
  // routing is intentionally limited to the two high-certainty cases above.
  return null;
}

export function mergeEmailTriageEvidence(
  modelDecision: EvidenceMergeableDecision,
  evidence: EvidenceBasedEmailDecision,
): EvidenceMergeableDecision {
  const preserveDraft =
    evidence.action === "label_only" &&
    modelDecision.action === "draft_reply" &&
    Boolean(modelDecision.draftReply?.trim());
  const merged: EvidenceMergeableDecision = {
    ...modelDecision,
    ...evidence,
    messageKind: modelDecision.messageKind,
    critical: modelDecision.critical || evidence.critical,
    ...(preserveDraft
      ? {
          action: "draft_reply",
          reason: modelDecision.reason,
          autoExecute: false,
          draftReply: modelDecision.draftReply,
          targetThreadId: modelDecision.targetThreadId,
          targetMessageIdHeader: modelDecision.targetMessageIdHeader,
          targetReason: modelDecision.targetReason,
        }
      : {
          draftReply: "",
          targetThreadId: undefined,
          targetMessageIdHeader: undefined,
          targetReason: undefined,
        }),
  };
  if (!preserveDraft) return merged;
  return {
    ...merged,
    confidence: Math.max(modelDecision.confidence, evidence.confidence),
    pImportant: Math.max(modelDecision.pImportant, evidence.pImportant),
    pSpam: Math.min(modelDecision.pSpam, evidence.pSpam),
    pActionable: Math.max(modelDecision.pActionable, evidence.pActionable),
  };
}
