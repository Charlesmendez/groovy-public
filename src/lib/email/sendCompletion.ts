/**
 * Sending and completing a workspace conversation are separate user actions.
 * A successful send consumes the Gmail draft, but it must not move the
 * conversation out of Focus/Needs Review or overwrite an explicit placement.
 */
export const SENT_EMAIL_ACTION_DRAFT_CLEAR = {
  gmail_draft_id: null,
  draft_to: null,
  draft_cc: null,
  draft_bcc: null,
  draft_subject: null,
  draft_body: null,
} as const;

export function sentEmailActionMetadataPatch(args: {
  sentAt: string;
  attachmentNames?: readonly string[];
}): Record<string, unknown> {
  return {
    email_draft_body_html: null,
    email_draft_attachments: [],
    ...(args.attachmentNames
      ? { sent_attachment_names: [...args.attachmentNames] }
      : {}),
    sent_from_email_workspace: true,
    sent_at: args.sentAt,
    send_confirmation_pending: false,
  };
}
