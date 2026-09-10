import assert from "node:assert/strict";
import test from "node:test";
import { defaultComposerMailbox } from "./composerMailbox";
import type { EmailMailbox } from "./types";

function mailbox(
  connectionId: string,
  options: Partial<EmailMailbox> = {},
): EmailMailbox {
  return {
    connectionId,
    provider: "gmail",
    address: `${connectionId}@example.com`,
    displayName: connectionId,
    color: "#22d3ee",
    monogram: connectionId.slice(0, 1).toUpperCase(),
    isDefaultSender: false,
    includedInUnified: true,
    aiInstructions: "",
    status: "connected",
    counts: { inbox: 0, focus: 0, drafts: 0, noise: 0 },
    ...options,
  };
}

test("new messages prefer the currently selected connected mailbox", () => {
  const work = mailbox("work", { isDefaultSender: true });
  const personal = mailbox("personal");
  assert.equal(
    defaultComposerMailbox([work, personal], "personal")?.connectionId,
    "personal",
  );
});

test("new messages skip unavailable defaults when a mailbox is connected", () => {
  const unavailable = mailbox("old-default", {
    isDefaultSender: true,
    status: "reauth_required",
  });
  const connected = mailbox("connected");
  assert.equal(
    defaultComposerMailbox([unavailable, connected])?.connectionId,
    "connected",
  );
});
