import assert from "node:assert/strict";
import test from "node:test";
import {
  SENT_EMAIL_ACTION_DRAFT_CLEAR,
  sentEmailActionMetadataPatch,
} from "./sendCompletion";

test("send completion clears the consumed draft without completing the conversation", () => {
  const patch = sentEmailActionMetadataPatch({
    sentAt: "2026-08-28T14:00:00.000Z",
    attachmentNames: ["audit.pdf"],
  });

  assert.deepEqual(SENT_EMAIL_ACTION_DRAFT_CLEAR, {
    gmail_draft_id: null,
    draft_to: null,
    draft_cc: null,
    draft_bcc: null,
    draft_subject: null,
    draft_body: null,
  });
  assert.deepEqual(patch, {
    email_draft_body_html: null,
    email_draft_attachments: [],
    sent_attachment_names: ["audit.pdf"],
    sent_from_email_workspace: true,
    sent_at: "2026-08-28T14:00:00.000Z",
    send_confirmation_pending: false,
  });
  assert.equal("email_workspace_override_view" in patch, false);
  assert.equal("email_workspace_corrected_at" in patch, false);
  assert.equal("email_workspace_user_action" in patch, false);
  assert.equal("status" in patch, false);
});
