import assert from "node:assert/strict";
import test from "node:test";
import {
  EMAIL_FOCUS_SNAPSHOT_AT_HEADER,
  EMAIL_FOCUS_SNAPSHOT_CACHE,
  EMAIL_FOCUS_SNAPSHOT_KIND_HEADER,
  EMAIL_FOCUS_SNAPSHOT_MAX_AGE_MS,
  emailFocusSnapshotUrl,
  readEmailBackgroundFocusSnapshot,
  writeEmailBackgroundFocusSnapshot,
} from "./backgroundFeedCache";
import { EMAIL_FEED_SCHEMA_VERSION, type EmailFeedResponse } from "./types";

function feed(): EmailFeedResponse {
  const mailbox = {
    connectionId: "gmail-work",
    provider: "gmail" as const,
    address: "owner@example.com",
    displayName: "Work",
    color: "#22d3ee",
    monogram: "WO",
    isDefaultSender: true,
    includedInUnified: true,
    aiInstructions: "",
    status: "connected" as const,
    counts: { inbox: 1, focus: 1, drafts: 0, noise: 0 },
  };
  return {
    schemaVersion: EMAIL_FEED_SCHEMA_VERSION,
    view: "focus",
    mailboxes: [mailbox],
    threads: [{
      key: "gmail-work:message-1",
      connectionId: "gmail-work",
      mailbox,
      messageId: "message-1",
      threadId: "thread-1",
      senderName: "Alex",
      senderEmail: "alex@example.com",
      recipients: ["owner@example.com"],
      subject: "Background arrival",
      snippet: "Already waiting when the app opens",
      receivedAt: "2026-08-05T12:00:00.000Z",
      unread: true,
      starred: false,
      hasAttachments: false,
      direction: "incoming",
      openStatus: null,
      calendarInvite: null,
      action: null,
      draft: null,
    }],
    nextCursor: null,
    warnings: [],
    stats: {
      focus: 1,
      processed: 0,
      draftsReady: 0,
      needsReview: 0,
      noiseCaught: 0,
    },
  };
}

function cacheStorage(response: Response | null) {
  return {
    opened: "",
    matched: "",
    async open(name: string) {
      this.opened = name;
      return {
        match: async (url: string) => {
          this.matched = url;
          return response || undefined;
        },
      };
    },
  };
}

test("restores a fresh background Focus snapshot for the same user", async () => {
  const savedAt = 10_000;
  const response = new Response(JSON.stringify({ ok: true, ...feed() }), {
    status: 200,
    headers: { [EMAIL_FOCUS_SNAPSHOT_AT_HEADER]: String(savedAt) },
  });
  const storage = cacheStorage(response);
  const restored = await readEmailBackgroundFocusSnapshot({
    scope: "user-1",
    cacheStorage: storage,
    now: savedAt + 1_000,
  });
  assert.equal(storage.opened, EMAIL_FOCUS_SNAPSHOT_CACHE);
  assert.equal(
    storage.matched,
    emailFocusSnapshotUrl("user-1"),
  );
  assert.equal(restored?.feed.threads[0]?.subject, "Background arrival");
  assert.equal(restored?.savedAt, savedAt);
  assert.equal(restored?.kind, "full");
});

test("identifies a notification delta snapshot", async () => {
  const savedAt = 10_000;
  const response = new Response(JSON.stringify({ ok: true, ...feed() }), {
    status: 200,
    headers: {
      [EMAIL_FOCUS_SNAPSHOT_AT_HEADER]: String(savedAt),
      [EMAIL_FOCUS_SNAPSHOT_KIND_HEADER]: "notification",
    },
  });
  const restored = await readEmailBackgroundFocusSnapshot({
    scope: "user-1",
    cacheStorage: cacheStorage(response),
    now: savedAt + 1_000,
  });
  assert.equal(restored?.kind, "notification");
});

test("rejects stale or malformed background snapshots", async () => {
  const savedAt = 10_000;
  const stale = new Response(JSON.stringify({ ok: true, ...feed() }), {
    status: 200,
    headers: { [EMAIL_FOCUS_SNAPSHOT_AT_HEADER]: String(savedAt) },
  });
  assert.equal(
    await readEmailBackgroundFocusSnapshot({
      scope: "user-1",
      cacheStorage: cacheStorage(stale),
      now: savedAt + EMAIL_FOCUS_SNAPSHOT_MAX_AGE_MS + 1,
    }),
    null,
  );
  const malformed = new Response(JSON.stringify({ view: "focus" }), {
    status: 200,
    headers: { [EMAIL_FOCUS_SNAPSHOT_AT_HEADER]: String(savedAt) },
  });
  assert.equal(
    await readEmailBackgroundFocusSnapshot({
      scope: "user-1",
      cacheStorage: cacheStorage(malformed),
      now: savedAt + 1,
    }),
    null,
  );
});

test("writes a user-scoped Focus snapshot that can be restored", async () => {
  const stored: Array<{ url: string; response: Response }> = [];
  const storage = {
    async open(name: string) {
      assert.equal(name, EMAIL_FOCUS_SNAPSHOT_CACHE);
      return {
        put: async (url: string, response: Response) => {
          stored.push({ url, response });
        },
      };
    },
  };
  assert.equal(
    await writeEmailBackgroundFocusSnapshot({
      scope: "user-1",
      feed: feed(),
      cacheStorage: storage,
      savedAt: 10_000,
    }),
    true,
  );
  assert.equal(stored[0]?.url, emailFocusSnapshotUrl("user-1"));
  const storedResponse = stored[0]?.response;
  assert.ok(storedResponse);
  assert.equal(
    storedResponse.headers.get(EMAIL_FOCUS_SNAPSHOT_AT_HEADER),
    "10000",
  );
  assert.equal(
    storedResponse.headers.get(EMAIL_FOCUS_SNAPSHOT_KIND_HEADER),
    "full",
  );
  const payload = (await storedResponse.json()) as EmailFeedResponse;
  assert.equal(payload.threads[0]?.subject, "Background arrival");
});

test("writes a notification delta without presenting it as a complete queue", async () => {
  const stored: Response[] = [];
  const storage = {
    async open() {
      return {
        put: async (_url: string, response: Response) => {
          stored.push(response);
        },
      };
    },
  };
  assert.equal(
    await writeEmailBackgroundFocusSnapshot({
      scope: "user-1",
      feed: feed(),
      cacheStorage: storage,
      kind: "notification",
    }),
    true,
  );
  assert.equal(
    stored[0]?.headers.get(EMAIL_FOCUS_SNAPSHOT_KIND_HEADER),
    "notification",
  );
});
