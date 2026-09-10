import {
  runEmailActionWithRetry,
  retryableEmailActionError,
  type EmailActionAttemptState,
} from "./actionQueue";
import type {
  EmailDraftAttachment,
  EmailThreadSummary,
} from "./types";
import { EMAIL_DRAFT_HTML_MAX_CHARS } from "./payloadLimits";

export const EMAIL_SEND_COMPLETED_EVENT = "groovy:email-send-completed";
export const EMAIL_SEND_FAILED_EVENT = "groovy:email-send-failed";

const PENDING_STORAGE_VERSION = 1;
const PENDING_STORAGE_PREFIX = "groovy:pending-email-sends:v1:";
const COMPLETED_STORAGE_PREFIX = "groovy:completed-email-sends:v1:";
const FAILED_STORAGE_PREFIX = "groovy:failed-email-sends:v1:";
const MAX_PENDING_SENDS = 20;
const MAX_COMPLETED_SENDS = 30;
const PENDING_SEND_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const COMPLETED_SEND_TTL_MS = 60 * 60 * 1_000;
const MAX_KEEPALIVE_BODY_BYTES = 60_000;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type DurableEmailSendRequest = {
  version: typeof PENDING_STORAGE_VERSION;
  userId: string;
  requestId: string;
  connectionId: string;
  draftId: string;
  actionId: string | null;
  threadId: string | null;
  bodyHtml: string | null;
  attachments: EmailDraftAttachment[];
  confirmAiDraft: boolean;
  allowSharedGroupTracking: boolean;
  queuedAt: number;
};

export type DurableEmailSendResult = {
  ok: true;
  sentThread: EmailThreadSummary | null;
  alreadySent?: boolean;
  actionHandled?: boolean;
  warning?: string;
};

export type CompletedEmailSend = {
  userId: string;
  requestId: string;
  connectionId: string;
  draftId: string;
  actionId: string | null;
  threadId: string | null;
  completedAt: number;
  result: DurableEmailSendResult;
};

export type FailedEmailSend = {
  userId: string;
  requestId: string;
  connectionId: string;
  draftId: string;
  retrying: boolean;
  status: number | null;
  payload: unknown;
  error: string;
  failedAt: number;
};

type DurableEmailSendOptions = {
  execute?: (
    request: DurableEmailSendRequest,
  ) => Promise<DurableEmailSendResult>;
  onState?: (state: EmailActionAttemptState) => void;
  retryDelaysMs?: readonly number[];
  sleep?: (delayMs: number) => Promise<void>;
  storage?: StorageLike | null;
};

const inFlightSends = new Map<string, Promise<DurableEmailSendResult>>();
const completedSendsInMemory = new Map<string, CompletedEmailSend[]>();
const failedSendsInMemory = new Map<string, FailedEmailSend[]>();

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function pendingStorageKey(userId: string): string {
  return `${PENDING_STORAGE_PREFIX}${userId}`;
}

function completedStorageKey(userId: string): string {
  return `${COMPLETED_STORAGE_PREFIX}${userId}`;
}

function failedStorageKey(userId: string): string {
  return `${FAILED_STORAGE_PREFIX}${userId}`;
}

function isDraftAttachment(value: unknown): value is EmailDraftAttachment {
  const source = record(value);
  return Boolean(
    source &&
      text(source.id) &&
      text(source.storagePath) &&
      text(source.filename) &&
      text(source.mimeType) &&
      typeof source.size === "number" &&
      (source.disposition === "attachment" ||
        source.disposition === "inline"),
  );
}

function durableRequest(value: unknown): DurableEmailSendRequest | null {
  const source = record(value);
  if (
    source?.version !== PENDING_STORAGE_VERSION ||
    !text(source.userId) ||
    !text(source.requestId) ||
    !text(source.connectionId) ||
    !text(source.draftId) ||
    typeof source.queuedAt !== "number"
  ) {
    return null;
  }
  return {
    version: PENDING_STORAGE_VERSION,
    userId: text(source.userId),
    requestId: text(source.requestId),
    connectionId: text(source.connectionId),
    draftId: text(source.draftId),
    actionId: text(source.actionId) || null,
    threadId: text(source.threadId) || null,
    bodyHtml:
      typeof source.bodyHtml === "string" ? source.bodyHtml : null,
    attachments: Array.isArray(source.attachments)
      ? source.attachments.filter(isDraftAttachment)
      : [],
    confirmAiDraft: source.confirmAiDraft === true,
    allowSharedGroupTracking: source.allowSharedGroupTracking === true,
    queuedAt: source.queuedAt,
  };
}

function completedSend(value: unknown): CompletedEmailSend | null {
  const source = record(value);
  const result = record(source?.result);
  if (
    !source ||
    !result ||
    result.ok !== true ||
    !text(source.userId) ||
    !text(source.requestId) ||
    !text(source.connectionId) ||
    !text(source.draftId) ||
    typeof source.completedAt !== "number"
  ) {
    return null;
  }
  return source as CompletedEmailSend;
}

function failedSend(value: unknown): FailedEmailSend | null {
  const source = record(value);
  if (
    !source ||
    !text(source.userId) ||
    !text(source.requestId) ||
    !text(source.connectionId) ||
    !text(source.draftId) ||
    source.retrying !== false ||
    typeof source.failedAt !== "number"
  ) {
    return null;
  }
  return source as FailedEmailSend;
}

function readStoredArray(storage: StorageLike, key: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStoredArray(
  storage: StorageLike,
  key: string,
  values: unknown[],
): void {
  try {
    if (values.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(values));
  } catch {
    // A send still runs in memory when browser storage is unavailable/full.
  }
}

export function readPendingEmailSends(
  storage: StorageLike,
  userId: string,
  now = Date.now(),
): DurableEmailSendRequest[] {
  const requests = readStoredArray(storage, pendingStorageKey(userId))
    .map(durableRequest)
    .filter(
      (request): request is DurableEmailSendRequest =>
        Boolean(
          request &&
            request.userId === userId &&
            now - request.queuedAt <= PENDING_SEND_TTL_MS,
        ),
    )
    .sort((left, right) => left.queuedAt - right.queuedAt)
    .slice(-MAX_PENDING_SENDS);
  writeStoredArray(storage, pendingStorageKey(userId), requests);
  return requests;
}

export function persistPendingEmailSend(
  storage: StorageLike,
  request: DurableEmailSendRequest,
): void {
  const current = readPendingEmailSends(storage, request.userId).filter(
    (candidate) => candidate.requestId !== request.requestId,
  );
  writeStoredArray(
    storage,
    pendingStorageKey(request.userId),
    [
      ...current,
      // Gmail already owns the saved draft body. Keep local recovery storage
      // limited to delivery identifiers and attachment references.
      { ...request, bodyHtml: null },
    ].slice(-MAX_PENDING_SENDS),
  );
}

export function removePendingEmailSend(
  storage: StorageLike,
  userId: string,
  requestId: string,
): void {
  writeStoredArray(
    storage,
    pendingStorageKey(userId),
    readPendingEmailSends(storage, userId).filter(
      (candidate) => candidate.requestId !== requestId,
    ),
  );
}

export function readCompletedEmailSends(
  storage: StorageLike,
  userId: string,
  now = Date.now(),
): CompletedEmailSend[] {
  const completions = readStoredArray(storage, completedStorageKey(userId))
    .map(completedSend)
    .filter(
      (completion): completion is CompletedEmailSend =>
        Boolean(
          completion &&
            completion.userId === userId &&
            now - completion.completedAt <= COMPLETED_SEND_TTL_MS,
        ),
    )
    .sort((left, right) => left.completedAt - right.completedAt)
    .slice(-MAX_COMPLETED_SENDS);
  writeStoredArray(storage, completedStorageKey(userId), completions);
  return completions;
}

function persistCompletedEmailSend(
  storage: StorageLike,
  completion: CompletedEmailSend,
): void {
  const current = readCompletedEmailSends(storage, completion.userId).filter(
    (candidate) => candidate.requestId !== completion.requestId,
  );
  writeStoredArray(
    storage,
    completedStorageKey(completion.userId),
    [...current, completion].slice(-MAX_COMPLETED_SENDS),
  );
}

function rememberCompletedEmailSend(completion: CompletedEmailSend): void {
  const current = completedSendsInMemory.get(completion.userId) || [];
  completedSendsInMemory.set(
    completion.userId,
    [
      ...current.filter(
        (candidate) => candidate.requestId !== completion.requestId,
      ),
      completion,
    ].slice(-MAX_COMPLETED_SENDS),
  );
}

export function recentCompletedEmailSends(
  userId: string,
  storage: StorageLike | null = browserStorage(),
): CompletedEmailSend[] {
  const merged = new Map<string, CompletedEmailSend>();
  if (storage) {
    for (const completion of readCompletedEmailSends(storage, userId)) {
      merged.set(completion.requestId, completion);
    }
  }
  for (const completion of completedSendsInMemory.get(userId) || []) {
    merged.set(completion.requestId, completion);
  }
  return Array.from(merged.values())
    .sort((left, right) => left.completedAt - right.completedAt)
    .slice(-MAX_COMPLETED_SENDS);
}

function rememberFailedEmailSend(
  failure: FailedEmailSend,
  storage: StorageLike | null,
): void {
  const current = failedSendsInMemory.get(failure.userId) || [];
  const next = [
    ...current.filter(
      (candidate) => candidate.requestId !== failure.requestId,
    ),
    failure,
  ].slice(-MAX_COMPLETED_SENDS);
  failedSendsInMemory.set(failure.userId, next);
  if (!storage) return;
  const stored = readStoredArray(storage, failedStorageKey(failure.userId))
    .map(failedSend)
    .filter(
      (candidate): candidate is FailedEmailSend =>
        Boolean(
          candidate &&
            Date.now() - candidate.failedAt <= COMPLETED_SEND_TTL_MS &&
            candidate.requestId !== failure.requestId,
        ),
    );
  writeStoredArray(
    storage,
    failedStorageKey(failure.userId),
    [...stored, failure].slice(-MAX_COMPLETED_SENDS),
  );
}

export function recentFailedEmailSends(
  userId: string,
  storage: StorageLike | null = browserStorage(),
): FailedEmailSend[] {
  const merged = new Map<string, FailedEmailSend>();
  if (storage) {
    const stored = readStoredArray(storage, failedStorageKey(userId))
      .map(failedSend)
      .filter(
        (failure): failure is FailedEmailSend =>
          Boolean(
            failure &&
              failure.userId === userId &&
              Date.now() - failure.failedAt <= COMPLETED_SEND_TTL_MS,
          ),
      );
    writeStoredArray(storage, failedStorageKey(userId), stored);
    for (const failure of stored) merged.set(failure.requestId, failure);
  }
  for (const failure of failedSendsInMemory.get(userId) || []) {
    if (Date.now() - failure.failedAt <= COMPLETED_SEND_TTL_MS) {
      merged.set(failure.requestId, failure);
    }
  }
  return Array.from(merged.values())
    .sort((left, right) => left.failedAt - right.failedAt)
    .slice(-MAX_COMPLETED_SENDS);
}

function apiRequestBody(request: DurableEmailSendRequest): string {
  return JSON.stringify({
    connectionId: request.connectionId,
    draftId: request.draftId,
    actionId: request.actionId,
    threadId: request.threadId,
    bodyHtml:
      typeof request.bodyHtml === "string"
        ? request.bodyHtml.slice(0, EMAIL_DRAFT_HTML_MAX_CHARS)
        : null,
    attachments: request.attachments,
    confirmAiDraft: request.confirmAiDraft,
    allowSharedGroupTracking: request.allowSharedGroupTracking,
    requestId: request.requestId,
  });
}

export function emailSendCanUseKeepalive(requestBody: string): boolean {
  return new TextEncoder().encode(requestBody).byteLength <=
    MAX_KEEPALIVE_BODY_BYTES;
}

async function executeBrowserEmailSend(
  request: DurableEmailSendRequest,
): Promise<DurableEmailSendResult> {
  const body = apiRequestBody(request);
  const response = await fetch("/api/email/draft/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    cache: "no-store",
    keepalive: emailSendCanUseKeepalive(body),
  });
  const payload = (await response.json().catch(() => ({}))) as
    | DurableEmailSendResult
    | Record<string, unknown>;
  if (!response.ok) {
    const source = record(payload);
    const error = new Error(
      text(source?.error) || "Could not send this email.",
    );
    Object.assign(error, { status: response.status, payload });
    throw error;
  }
  return payload as DurableEmailSendResult;
}

function sendIdentity(request: DurableEmailSendRequest): string {
  return `${request.userId}:${request.requestId}`;
}

function announce(
  name: typeof EMAIL_SEND_COMPLETED_EVENT | typeof EMAIL_SEND_FAILED_EVENT,
  detail: unknown,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function sendEmailDraftDurably(
  request: DurableEmailSendRequest,
  options: DurableEmailSendOptions = {},
): Promise<DurableEmailSendResult> {
  const storage = options.storage === undefined
    ? browserStorage()
    : options.storage;
  if (storage) persistPendingEmailSend(storage, request);
  const identity = sendIdentity(request);
  const existing = inFlightSends.get(identity);
  if (existing) return existing;

  const execute = options.execute || executeBrowserEmailSend;
  const operation = runEmailActionWithRetry({
    execute: () => execute(request),
    onState: options.onState,
    retryDelaysMs: options.retryDelaysMs,
    sleep: options.sleep,
  })
    .then((result) => {
      if (storage) {
        removePendingEmailSend(
          storage,
          request.userId,
          request.requestId,
        );
      }
      const completion: CompletedEmailSend = {
        userId: request.userId,
        requestId: request.requestId,
        connectionId: request.connectionId,
        draftId: request.draftId,
        actionId: request.actionId,
        threadId: request.threadId,
        completedAt: Date.now(),
        result,
      };
      rememberCompletedEmailSend(completion);
      if (storage) persistCompletedEmailSend(storage, completion);
      announce(EMAIL_SEND_COMPLETED_EVENT, completion);
      return result;
    })
    .catch((error) => {
      const retrying = retryableEmailActionError(error);
      if (!retrying) {
        if (storage) {
          removePendingEmailSend(
            storage,
            request.userId,
            request.requestId,
          );
        }
      }
      const source = record(error);
      const failure: FailedEmailSend = {
        userId: request.userId,
        requestId: request.requestId,
        connectionId: request.connectionId,
        draftId: request.draftId,
        retrying,
        status:
          typeof source?.status === "number" ? source.status : null,
        payload: source?.payload,
        error: error instanceof Error ? error.message : "Could not send.",
        failedAt: Date.now(),
      };
      if (!retrying) rememberFailedEmailSend(failure, storage);
      announce(EMAIL_SEND_FAILED_EVENT, failure);
      throw error;
    })
    .finally(() => {
      if (inFlightSends.get(identity) === operation) {
        inFlightSends.delete(identity);
      }
    });
  inFlightSends.set(identity, operation);
  return operation;
}

export function resumePendingEmailSends(
  userId: string,
  storage: StorageLike | null = browserStorage(),
): Promise<unknown>[] {
  if (!storage) return [];
  return readPendingEmailSends(storage, userId).map((request) =>
    sendEmailDraftDurably(request, { storage }).catch(() => undefined),
  );
}
