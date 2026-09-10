import {
  EMAIL_DRAFT_BODY_MAX_CHARS,
  EMAIL_DRAFT_HTML_MAX_CHARS,
} from "./payloadLimits";
import type { EmailDraftAttachment } from "./types";

const EMAIL_COMPOSER_DRAFT_VERSION = 1;
const EMAIL_COMPOSER_DRAFT_PREFIX =
  `groovy.email.composer-drafts.v${EMAIL_COMPOSER_DRAFT_VERSION}:`;
const EMAIL_COMPOSER_DRAFT_MAX_COUNT = 20;

export type EmailComposerDraftSnapshot = {
  localId: string;
  actionId: string | null;
  draftId: string | null;
  connectionId: string;
  threadId: string | null;
  sourceMessageId: string | null;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  bodyHtml: string | null;
  attachments: EmailDraftAttachment[];
  inReplyTo: string | null;
  references: string | null;
  aiGenerated: boolean;
  untouched: boolean;
  updatedAt: number;
};

export type EmailComposerDraftInput = Omit<
  EmailComposerDraftSnapshot,
  "updatedAt"
>;

export type EmailComposerDraftState = {
  drafts: EmailComposerDraftSnapshot[];
  activeDraftId: string | null;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function text(value: unknown, max = 10_000): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function nullableText(value: unknown, max = 10_000): string | null {
  const normalized = text(value, max);
  return normalized || null;
}

function attachment(value: unknown): EmailDraftAttachment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const id = text(source.id, 120);
  const storagePath = text(source.storagePath, 1_000);
  const filename = text(source.filename, 180);
  const mimeType = text(source.mimeType, 180);
  const size = Number(source.size);
  if (
    !id ||
    !storagePath ||
    !filename ||
    !mimeType ||
    !Number.isFinite(size) ||
    size <= 0 ||
    (source.disposition !== "attachment" && source.disposition !== "inline")
  ) {
    return null;
  }
  return {
    id,
    storagePath,
    filename,
    mimeType,
    size,
    disposition: source.disposition,
    contentId: nullableText(source.contentId, 180),
  };
}

export function normalizeEmailComposerDraftSnapshot(
  value: unknown,
): EmailComposerDraftSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const localId = text(source.localId, 180);
  const connectionId = text(source.connectionId, 180);
  const updatedAt = Number(source.updatedAt);
  if (
    !localId ||
    !connectionId ||
    !Number.isFinite(updatedAt) ||
    !Number.isFinite(new Date(updatedAt).getTime())
  ) {
    return null;
  }
  return {
    localId,
    actionId: nullableText(source.actionId, 180),
    draftId: nullableText(source.draftId, 180),
    connectionId,
    threadId: nullableText(source.threadId, 180),
    sourceMessageId: nullableText(source.sourceMessageId, 180),
    to: text(source.to, 20_000),
    cc: text(source.cc, 20_000),
    bcc: text(source.bcc, 20_000),
    subject: text(source.subject, 998),
    body: text(source.body, EMAIL_DRAFT_BODY_MAX_CHARS),
    bodyHtml:
      typeof source.bodyHtml === "string"
        ? source.bodyHtml.slice(0, EMAIL_DRAFT_HTML_MAX_CHARS)
        : null,
    attachments: Array.isArray(source.attachments)
      ? source.attachments
          .map(attachment)
          .filter((item): item is EmailDraftAttachment => Boolean(item))
          .slice(0, 12)
      : [],
    inReplyTo: nullableText(source.inReplyTo, 10_000),
    references: nullableText(source.references, 20_000),
    aiGenerated: source.aiGenerated === true,
    untouched: source.untouched === true,
    updatedAt,
  };
}

function storageKey(scope: string): string {
  return `${EMAIL_COMPOSER_DRAFT_PREFIX}${encodeURIComponent(scope)}`;
}

export function emailComposerDraftHasContent(
  draft: Pick<
    EmailComposerDraftInput,
    "to" | "cc" | "bcc" | "subject" | "body" | "bodyHtml" | "attachments"
  >,
): boolean {
  return Boolean(
    draft.to.trim() ||
      draft.cc.trim() ||
      draft.bcc.trim() ||
      draft.subject.trim() ||
      draft.body.trim() ||
      draft.bodyHtml?.trim() ||
      draft.attachments.length,
  );
}

export function readEmailComposerDraftState(
  storage: StorageLike,
  scope: string,
): EmailComposerDraftState {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(storageKey(scope)) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { drafts: [], activeDraftId: null };
    }
    const source = parsed as Record<string, unknown>;
    if (source.version !== EMAIL_COMPOSER_DRAFT_VERSION) {
      return { drafts: [], activeDraftId: null };
    }
    const drafts = (Array.isArray(source.drafts) ? source.drafts : [])
      .map(normalizeEmailComposerDraftSnapshot)
      .filter((item): item is EmailComposerDraftSnapshot => Boolean(item))
      .filter(emailComposerDraftHasContent)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, EMAIL_COMPOSER_DRAFT_MAX_COUNT);
    const activeDraftId = text(source.activeDraftId, 180) || null;
    return {
      drafts,
      activeDraftId: drafts.some((draft) => draft.localId === activeDraftId)
        ? activeDraftId
        : null,
    };
  } catch {
    return { drafts: [], activeDraftId: null };
  }
}

function writeState(
  storage: StorageLike,
  scope: string,
  state: EmailComposerDraftState,
): void {
  const value = {
    version: EMAIL_COMPOSER_DRAFT_VERSION,
    drafts: state.drafts,
    activeDraftId: state.activeDraftId,
  };
  try {
    if (state.drafts.length === 0) storage.removeItem(storageKey(scope));
    else storage.setItem(storageKey(scope), JSON.stringify(value));
  } catch {
    // Draft autosave must never interrupt typing when browser storage is full
    // or unavailable. Gmail autosave remains the authoritative fallback.
  }
}

export function persistEmailComposerDraft(
  storage: StorageLike,
  scope: string,
  input: EmailComposerDraftInput,
  now = Date.now(),
): EmailComposerDraftState {
  const current = readEmailComposerDraftState(storage, scope);
  if (!emailComposerDraftHasContent(input)) {
    return removeEmailComposerDraft(storage, scope, input.localId);
  }
  const normalized = normalizeEmailComposerDraftSnapshot({
    ...input,
    updatedAt: now,
  });
  if (!normalized) return current;
  const drafts = [
    normalized,
    ...current.drafts.filter(
      (draft) =>
        draft.localId !== normalized.localId &&
        (!normalized.draftId || draft.draftId !== normalized.draftId),
    ),
  ].slice(0, EMAIL_COMPOSER_DRAFT_MAX_COUNT);
  const next = { drafts, activeDraftId: normalized.localId };
  writeState(storage, scope, next);
  return next;
}

export function mergeEmailComposerDraftSnapshots(
  current: readonly EmailComposerDraftSnapshot[],
  incoming: readonly EmailComposerDraftSnapshot[],
): EmailComposerDraftSnapshot[] {
  const candidates = [...current, ...incoming].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
  const localIds = new Set<string>();
  const gmailIds = new Set<string>();
  const merged: EmailComposerDraftSnapshot[] = [];
  for (const draft of candidates) {
    const gmailId = draft.draftId
      ? `${draft.connectionId}:${draft.draftId}`
      : "";
    if (
      localIds.has(draft.localId) ||
      (gmailId && gmailIds.has(gmailId))
    ) {
      continue;
    }
    localIds.add(draft.localId);
    if (gmailId) gmailIds.add(gmailId);
    merged.push(draft);
    if (merged.length >= EMAIL_COMPOSER_DRAFT_MAX_COUNT) break;
  }
  return merged;
}

export function setActiveEmailComposerDraft(
  storage: StorageLike,
  scope: string,
  localId: string | null,
): EmailComposerDraftState {
  const current = readEmailComposerDraftState(storage, scope);
  const activeDraftId = current.drafts.some(
    (draft) => draft.localId === localId,
  )
    ? localId
    : null;
  const next = { ...current, activeDraftId };
  writeState(storage, scope, next);
  return next;
}

export function removeEmailComposerDraft(
  storage: StorageLike,
  scope: string,
  localId: string,
): EmailComposerDraftState {
  const current = readEmailComposerDraftState(storage, scope);
  const drafts = current.drafts.filter((draft) => draft.localId !== localId);
  const next = {
    drafts,
    activeDraftId:
      current.activeDraftId === localId ? null : current.activeDraftId,
  };
  writeState(storage, scope, next);
  return next;
}
