import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertOwnedEmailDraftAttachments,
  EMAIL_DRAFT_ATTACHMENT_BUCKET,
  normalizeEmailDraftAttachments,
} from "@/lib/email/draftAttachments";
import type { EmailDraftAttachment } from "@/lib/email/types";

export type ResolvedEmailDraftAttachment = EmailDraftAttachment & {
  data: Uint8Array;
};

export async function resolveEmailDraftAttachments(args: {
  supabase: SupabaseClient;
  userId: string;
  value: unknown;
}): Promise<{
  attachments: EmailDraftAttachment[];
  resolved: ResolvedEmailDraftAttachment[];
}> {
  const attachments = normalizeEmailDraftAttachments(args.value);
  assertOwnedEmailDraftAttachments({
    userId: args.userId,
    attachments,
  });
  const resolved = await Promise.all(
    attachments.map(async (attachment) => {
      const downloaded = await args.supabase.storage
        .from(EMAIL_DRAFT_ATTACHMENT_BUCKET)
        .download(attachment.storagePath);
      if (downloaded.error || !downloaded.data) {
        throw new Error(
          `Could not load attachment "${attachment.filename}". Remove it and upload it again.`,
        );
      }
      const data = new Uint8Array(await downloaded.data.arrayBuffer());
      if (data.byteLength !== attachment.size) {
        throw new Error(
          `Attachment "${attachment.filename}" changed while the draft was open.`,
        );
      }
      return { ...attachment, data };
    }),
  );
  return { attachments, resolved };
}

export async function removeEmailDraftAttachments(args: {
  supabase: SupabaseClient;
  userId: string;
  value: unknown;
}): Promise<void> {
  const attachments = normalizeEmailDraftAttachments(args.value);
  assertOwnedEmailDraftAttachments({
    userId: args.userId,
    attachments,
  });
  const paths = Array.from(
    new Set(attachments.map((attachment) => attachment.storagePath)),
  );
  if (paths.length === 0) return;
  const removed = await args.supabase.storage
    .from(EMAIL_DRAFT_ATTACHMENT_BUCKET)
    .remove(paths);
  if (removed.error) {
    console.warn(
      "[email/draft] Could not remove temporary attachments:",
      removed.error.message,
    );
  }
}
