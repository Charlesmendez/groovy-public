import type { SupabaseClient } from "@supabase/supabase-js";
import {
  normalizeEmailComposerDraftSnapshot,
  type EmailComposerDraftInput,
  type EmailComposerDraftSnapshot,
} from "@/lib/email/composerDrafts";
import { sanitizeEmailHtml } from "@/lib/email/html";

const EMAIL_COMPOSER_DRAFT_RESPONSE_MAX_BYTES = 2_500_000;
const EMAIL_COMPOSER_DRAFT_SYNC_LIMIT = 20;

type RecordLike = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function syncedEmailComposerDraftFromRow(
  value: unknown,
): EmailComposerDraftSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as RecordLike;
  const updatedAt = Date.parse(text(row.updated_at));
  const draft = normalizeEmailComposerDraftSnapshot({
    localId: row.local_id,
    actionId: row.action_id,
    draftId: row.gmail_draft_id,
    connectionId: row.connection_id,
    threadId: row.gmail_thread_id,
    sourceMessageId: row.gmail_source_message_id,
    to: row.to_recipients,
    cc: row.cc_recipients,
    bcc: row.bcc_recipients,
    subject: row.subject,
    body: row.body,
    bodyHtml: row.body_html,
    attachments: row.attachments,
    inReplyTo: row.in_reply_to,
    references: row.references_header,
    aiGenerated: row.ai_generated,
    untouched: row.untouched,
    updatedAt,
  });
  return draft
    ? {
        ...draft,
        bodyHtml: draft.bodyHtml ? sanitizeEmailHtml(draft.bodyHtml) : null,
      }
    : null;
}

export async function loadSyncedEmailComposerDrafts(args: {
  supabase: SupabaseClient;
  userId: string;
  connectionIds?: readonly string[];
}): Promise<EmailComposerDraftSnapshot[]> {
  let query = args.supabase
    .from("email_composer_drafts")
    .select(
      "local_id,action_id,gmail_draft_id,connection_id,gmail_thread_id,gmail_source_message_id,to_recipients,cc_recipients,bcc_recipients,subject,body,body_html,attachments,in_reply_to,references_header,ai_generated,untouched,updated_at",
    )
    .eq("user_id", args.userId)
    .order("updated_at", { ascending: false })
    .limit(EMAIL_COMPOSER_DRAFT_SYNC_LIMIT);
  if (args.connectionIds) {
    if (args.connectionIds.length === 0) return [];
    query = query.in("connection_id", [...args.connectionIds]);
  }
  const result = await query;
  if (result.error) throw new Error(result.error.message);

  const drafts: EmailComposerDraftSnapshot[] = [];
  let responseBytes = 0;
  for (const row of result.data || []) {
    const draft = syncedEmailComposerDraftFromRow(row);
    if (!draft) continue;
    const draftBytes = Buffer.byteLength(JSON.stringify(draft), "utf8");
    if (
      drafts.length > 0 &&
      responseBytes + draftBytes > EMAIL_COMPOSER_DRAFT_RESPONSE_MAX_BYTES
    ) {
      break;
    }
    drafts.push(draft);
    responseBytes += draftBytes;
  }
  return drafts;
}

export async function persistSyncedEmailComposerDraft(args: {
  supabase: SupabaseClient;
  userId: string;
  draft: EmailComposerDraftInput & { draftId: string };
  updatedAt?: string;
}): Promise<void> {
  const updatedAt = args.updatedAt || new Date().toISOString();
  const result = await args.supabase.from("email_composer_drafts").upsert(
    syncedDraftRow(args.userId, args.draft, updatedAt),
    { onConflict: "user_id,connection_id,gmail_draft_id" },
  );
  if (result.error) throw new Error(result.error.message);
}

function syncedDraftRow(
  userId: string,
  draft: EmailComposerDraftInput & { draftId: string },
  updatedAt: string,
) {
  return {
    user_id: userId,
    local_id: draft.localId,
    action_id: draft.actionId,
    gmail_draft_id: draft.draftId,
    connection_id: draft.connectionId,
    gmail_thread_id: draft.threadId,
    gmail_source_message_id: draft.sourceMessageId,
    to_recipients: draft.to,
    cc_recipients: draft.cc,
    bcc_recipients: draft.bcc,
    subject: draft.subject,
    body: draft.body,
    body_html: draft.bodyHtml,
    attachments: draft.attachments,
    in_reply_to: draft.inReplyTo,
    references_header: draft.references,
    ai_generated: draft.aiGenerated,
    untouched: draft.untouched,
    updated_at: updatedAt,
  };
}

export async function registerSyncedEmailComposerDraftIfMissing(args: {
  supabase: SupabaseClient;
  userId: string;
  draft: EmailComposerDraftInput & { draftId: string };
  updatedAt: string;
}): Promise<void> {
  const result = await args.supabase.from("email_composer_drafts").upsert(
    syncedDraftRow(args.userId, args.draft, args.updatedAt),
    {
      onConflict: "user_id,connection_id,gmail_draft_id",
      ignoreDuplicates: true,
    },
  );
  if (result.error) throw new Error(result.error.message);
}

export async function removeSyncedEmailComposerDraft(args: {
  supabase: SupabaseClient;
  userId: string;
  connectionId: string;
  draftId: string;
}): Promise<void> {
  const result = await args.supabase
    .from("email_composer_drafts")
    .delete()
    .eq("user_id", args.userId)
    .eq("connection_id", args.connectionId)
    .eq("gmail_draft_id", args.draftId);
  if (result.error) throw new Error(result.error.message);
}
