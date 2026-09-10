import assert from "node:assert/strict";
import test from "node:test";
import { syncedEmailComposerDraftFromRow } from "./composerDraftSync";

test("server draft rows hydrate into cross-device composer snapshots", () => {
  const draft = syncedEmailComposerDraftFromRow({
    local_id: "local-1",
    action_id: null,
    gmail_draft_id: "gmail-1",
    connection_id: "mailbox-1",
    gmail_thread_id: "thread-1",
    gmail_source_message_id: null,
    to_recipients: "friend@example.com",
    cc_recipients: "",
    bcc_recipients: "",
    subject: "Mobile continuation",
    body: "Line one\nLine two",
    body_html: "Line one<div>Line two</div>",
    attachments: [],
    in_reply_to: null,
    references_header: null,
    ai_generated: false,
    untouched: false,
    updated_at: "2026-09-10T14:30:00.000Z",
  });

  assert.equal(draft?.draftId, "gmail-1");
  assert.equal(draft?.body, "Line one\nLine two");
  assert.equal(draft?.bodyHtml, "Line one<div>Line two</div>");
  assert.equal(draft?.updatedAt, Date.parse("2026-09-10T14:30:00.000Z"));
});

test("invalid server draft rows are rejected before reaching the composer", () => {
  assert.equal(
    syncedEmailComposerDraftFromRow({
      local_id: "",
      connection_id: "mailbox-1",
      updated_at: "not-a-date",
    }),
    null,
  );
});
