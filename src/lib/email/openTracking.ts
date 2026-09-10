import { createHash, randomBytes } from "node:crypto";
import type { EmailOpenStatus } from "@/lib/email/types";

type RecordLike = Record<string, unknown>;

export const EMAIL_TRACKING_METADATA_KEY = "email_tracking_record";
export const EMAIL_TRACKING_MIN_OPEN_DELAY_MS = 5_000;
export const EMAIL_TRACKING_RECIPIENT_HASHES_KEY =
  "email_tracking_recipient_token_hashes";
export const EMAIL_TRACKING_RECIPIENT_DELIVERIES_KEY =
  "email_tracking_recipient_deliveries";
export const EMAIL_TRACKING_RECIPIENT_RECORD_KEY =
  "email_tracking_recipient_record";

export type EmailTrackingRecipientDelivery = {
  recipient: string;
  tokenHash: string;
  tokenEncrypted?: string;
  state: "prepared" | "sending" | "sent" | "failed";
  sentAt: string | null;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  openCount: number;
};

function record(value: unknown): RecordLike {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

export function emailTrackingRecipientDeliveries(
  value: unknown,
): EmailTrackingRecipientDelivery[] {
  const rows = Array.isArray(value) ? value : [];
  const deliveries: EmailTrackingRecipientDelivery[] = [];
  for (const value of rows) {
    const item = record(value);
    const recipient = text(item.recipient).toLowerCase();
    const tokenHash = text(item.tokenHash);
    if (!recipient || !/^[a-f0-9]{64}$/i.test(tokenHash)) continue;
    const rawState = text(item.state);
    const state: EmailTrackingRecipientDelivery["state"] =
      rawState === "sending" ||
      rawState === "sent" ||
      rawState === "failed"
        ? rawState
        : "prepared";
    deliveries.push({
      recipient,
      tokenHash,
      ...(text(item.tokenEncrypted)
        ? { tokenEncrypted: text(item.tokenEncrypted) }
        : {}),
      state,
      sentAt: text(item.sentAt) || null,
      firstOpenedAt: text(item.firstOpenedAt) || null,
      lastOpenedAt: text(item.lastOpenedAt) || null,
      openCount: nonNegativeInteger(item.openCount),
    });
  }
  return deliveries;
}

export function createEmailTrackingToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashEmailTrackingToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function emailTrackingPixelUrl(
  origin: string,
  token: string,
): string {
  return `${new URL(origin).origin}/api/email/open/${encodeURIComponent(token)}.gif`;
}

export function isEmailTrackingRecord(value: unknown): boolean {
  return record(record(value).metadata)[EMAIL_TRACKING_METADATA_KEY] === true;
}

export function emailOpenStatusFromTrackingRow(
  value: unknown,
): EmailOpenStatus | null {
  const row = record(value);
  const metadata = record(row.metadata);
  if (
    metadata[EMAIL_TRACKING_METADATA_KEY] !== true ||
    metadata.email_tracking_disabled === true
  ) {
    return null;
  }
  const recipientDeliveries = emailTrackingRecipientDeliveries(
    metadata[EMAIL_TRACKING_RECIPIENT_DELIVERIES_KEY],
  );
  const recipients =
    recipientDeliveries.length > 0
      ? recipientDeliveries.map((delivery) => delivery.recipient)
      : stringArray(metadata.email_tracking_recipients);
  const openedAt =
    text(metadata.email_tracking_first_opened_at) ||
    text(metadata.email_tracking_last_opened_at) ||
    null;
  const parsedCount = Number(metadata.email_tracking_open_count || 0);
  return {
    recipients,
    attribution:
      recipients.length === 1
        ? "single_recipient"
        : recipientDeliveries.length > 0
          ? "recipient_specific"
          : "group",
    openedAt,
    lastOpenedAt:
      text(metadata.email_tracking_last_opened_at) || openedAt,
    openCount: Number.isFinite(parsedCount)
      ? Math.max(0, Math.floor(parsedCount))
      : openedAt
        ? 1
        : 0,
    ...(recipientDeliveries.length > 0
      ? {
          recipientStatuses: recipientDeliveries.map((delivery) => ({
            recipient: delivery.recipient,
            openedAt: delivery.firstOpenedAt,
            lastOpenedAt:
              delivery.lastOpenedAt || delivery.firstOpenedAt,
            openCount: delivery.openCount,
          })),
        }
      : {}),
  };
}

export function emailOpenStatusFromTrackingRows(
  values: unknown[],
): EmailOpenStatus | null {
  const rows = values.map(record);
  if (rows.length === 0) return null;
  const parent =
    rows.find((row) => {
      const metadata = record(row.metadata);
      return (
        metadata[EMAIL_TRACKING_METADATA_KEY] === true &&
        metadata[EMAIL_TRACKING_RECIPIENT_RECORD_KEY] !== true &&
        emailTrackingRecipientDeliveries(
          metadata[EMAIL_TRACKING_RECIPIENT_DELIVERIES_KEY],
        ).length > 0
      );
    }) || rows[0];
  const parentStatus = emailOpenStatusFromTrackingRow(parent);
  if (
    !parentStatus ||
    parentStatus.attribution !== "recipient_specific"
  ) {
    return parentStatus;
  }
  const parentId = text(parent.id);
  const childStatuses = new Map<
    string,
    NonNullable<EmailOpenStatus["recipientStatuses"]>[number]
  >();
  for (const row of rows) {
    const metadata = record(row.metadata);
    if (
      metadata[EMAIL_TRACKING_RECIPIENT_RECORD_KEY] !== true ||
      (parentId &&
        text(metadata.email_tracking_parent_record_id) !== parentId)
    ) {
      continue;
    }
    const childStatus = emailOpenStatusFromTrackingRow(row);
    const recipient = childStatus?.recipients[0];
    if (!childStatus || !recipient) continue;
    childStatuses.set(recipient, {
      recipient,
      openedAt: childStatus.openedAt,
      lastOpenedAt: childStatus.lastOpenedAt,
      openCount: childStatus.openCount,
    });
  }
  const recipientStatuses = parentStatus.recipients.map((recipient) => {
    return (
      childStatuses.get(recipient) ||
      parentStatus.recipientStatuses?.find(
        (item) => item.recipient === recipient,
      ) || {
        recipient,
        openedAt: null,
        lastOpenedAt: null,
        openCount: 0,
      }
    );
  });
  const openedTimes = recipientStatuses
    .map((item) => item.openedAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  const lastOpenedTimes = recipientStatuses
    .map((item) => item.lastOpenedAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  return {
    ...parentStatus,
    openedAt: openedTimes[0] || null,
    lastOpenedAt:
      lastOpenedTimes[lastOpenedTimes.length - 1] ||
      openedTimes[0] ||
      null,
    openCount: recipientStatuses.reduce(
      (sum, item) => sum + item.openCount,
      0,
    ),
    recipientStatuses,
  };
}

export function recordEmailTrackingOpen(args: {
  metadata: RecordLike;
  tokenHash: string;
  now: string;
}): RecordLike | null {
  const deliveries = emailTrackingRecipientDeliveries(
    args.metadata[EMAIL_TRACKING_RECIPIENT_DELIVERIES_KEY],
  );
  const deliveryIndex = deliveries.findIndex(
    (delivery) => delivery.tokenHash === args.tokenHash,
  );
  const legacyMatch =
    text(args.metadata.email_tracking_token_hash) === args.tokenHash;
  if (deliveryIndex < 0 && !legacyMatch) return null;

  const priorAggregateCount = nonNegativeInteger(
    args.metadata.email_tracking_open_count,
  );
  const updated: RecordLike = {
    ...args.metadata,
    email_tracking_first_opened_at:
      text(args.metadata.email_tracking_first_opened_at) || args.now,
    email_tracking_last_opened_at: args.now,
    email_tracking_open_count: priorAggregateCount + 1,
  };
  if (deliveryIndex >= 0) {
    const current = deliveries[deliveryIndex];
    deliveries[deliveryIndex] = {
      ...current,
      firstOpenedAt: current.firstOpenedAt || args.now,
      lastOpenedAt: args.now,
      openCount: current.openCount + 1,
    };
    updated[EMAIL_TRACKING_RECIPIENT_DELIVERIES_KEY] = deliveries;
  }
  return updated;
}

export function shouldCountEmailOpen(args: {
  sentAt?: string | null;
  userAgent?: string | null;
  nowMs?: number;
}): boolean {
  const sentAtMs = Date.parse(args.sentAt || "");
  const nowMs = args.nowMs ?? Date.now();
  if (
    Number.isFinite(sentAtMs) &&
    nowMs - sentAtMs < EMAIL_TRACKING_MIN_OPEN_DELAY_MS
  ) {
    return false;
  }
  const userAgent = args.userAgent || "";
  return !/(barracuda|mimecast|proofpoint|safelinks|symantec|emailprotections|urlscan|spider|crawler|bot\b)/i.test(
    userAgent,
  );
}
