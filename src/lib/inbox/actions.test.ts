import assert from "node:assert/strict";
import test from "node:test";
import { inboxActionCompletionMetadataPatch } from "./actions";

test("completion deltas cannot replay stale workspace state", () => {
  assert.deepEqual(
    inboxActionCompletionMetadataPatch({
      approved_via: "command",
      execution_detail: "sent",
      email_workspace_override_view: "focus",
      email_workspace_corrected_at: "2026-08-24T18:00:00.000Z",
      email_workspace_unread: true,
      email_workspace_read_changed_at: "2026-08-24T18:00:00.000Z",
    }),
    {
      approved_via: "command",
      execution_detail: "sent",
    },
  );
});
