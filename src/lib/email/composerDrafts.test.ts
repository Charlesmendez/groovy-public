import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeEmailComposerDraftSnapshots,
  persistEmailComposerDraft,
  readEmailComposerDraftState,
  removeEmailComposerDraft,
  setActiveEmailComposerDraft,
  type EmailComposerDraftInput,
} from "./composerDrafts";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function draft(overrides: Partial<EmailComposerDraftInput> = {}) {
  return {
    localId: "local-1",
    actionId: null,
    draftId: null,
    connectionId: "mailbox-1",
    threadId: null,
    sourceMessageId: null,
    to: "",
    cc: "",
    bcc: "",
    subject: "A recoverable draft",
    body: "Still writing",
    bodyHtml: null,
    attachments: [],
    inReplyTo: null,
    references: null,
    aiGenerated: false,
    untouched: false,
    ...overrides,
  } satisfies EmailComposerDraftInput;
}

test("composer drafts survive a fresh store read and remain account scoped", () => {
  const storage = new MemoryStorage();
  persistEmailComposerDraft(storage, "user-1", draft(), 100);

  assert.deepEqual(
    readEmailComposerDraftState(storage, "user-1").drafts.map((item) => ({
      id: item.localId,
      body: item.body,
    })),
    [{ id: "local-1", body: "Still writing" }],
  );
  assert.deepEqual(readEmailComposerDraftState(storage, "user-2").drafts, []);
});

test("saving the same Gmail draft replaces its earlier local recovery entry", () => {
  const storage = new MemoryStorage();
  persistEmailComposerDraft(
    storage,
    "user-1",
    draft({ localId: "before-gmail", draftId: "gmail-1" }),
    100,
  );
  const state = persistEmailComposerDraft(
    storage,
    "user-1",
    draft({ localId: "after-refresh", draftId: "gmail-1", body: "Latest" }),
    200,
  );

  assert.equal(state.drafts.length, 1);
  assert.equal(state.drafts[0].localId, "after-refresh");
  assert.equal(state.drafts[0].body, "Latest");
  assert.equal(state.activeDraftId, "after-refresh");
});

test("closed drafts stay listed while discarded drafts are removed", () => {
  const storage = new MemoryStorage();
  persistEmailComposerDraft(storage, "user-1", draft(), 100);
  const closed = setActiveEmailComposerDraft(
    storage,
    "user-1",
    null,
  );
  assert.equal(closed.activeDraftId, null);
  assert.equal(closed.drafts.length, 1);

  const removed = removeEmailComposerDraft(
    storage,
    "user-1",
    "local-1",
  );
  assert.deepEqual(removed, { drafts: [], activeDraftId: null });
});

test("empty composers are not presented as drafts", () => {
  const storage = new MemoryStorage();
  const state = persistEmailComposerDraft(
    storage,
    "user-1",
    draft({ subject: "", body: "" }),
    100,
  );
  assert.deepEqual(state, { drafts: [], activeDraftId: null });
});

test("cross-device drafts merge by Gmail identity and keep the newest copy", () => {
  const local = persistEmailComposerDraft(
    new MemoryStorage(),
    "user-1",
    draft({ draftId: "gmail-1", body: "Desktop version" }),
    100,
  ).drafts[0];
  const remote = {
    ...local,
    localId: "mobile-copy",
    body: "Mobile version",
    updatedAt: 200,
  };

  const merged = mergeEmailComposerDraftSnapshots([local], [remote]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].localId, "mobile-copy");
  assert.equal(merged[0].body, "Mobile version");
});

test("cross-device merging preserves local drafts that have not reached Gmail", () => {
  const storage = new MemoryStorage();
  const local = persistEmailComposerDraft(
    storage,
    "user-1",
    draft({ localId: "local-only", draftId: null }),
    300,
  ).drafts[0];
  const remote = {
    ...local,
    localId: "remote",
    draftId: "gmail-2",
    updatedAt: 200,
  };

  const merged = mergeEmailComposerDraftSnapshots([local], [remote]);

  assert.deepEqual(
    merged.map((item) => item.localId),
    ["local-only", "remote"],
  );
});
