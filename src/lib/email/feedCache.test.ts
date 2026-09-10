import assert from "node:assert/strict";
import test from "node:test";
import {
  clearEmailFeedCache,
  EMAIL_FEED_CACHE_MAX_AGE_MS,
  emailFeedCacheRevision,
  isEmailFeedCacheRevisionCurrent,
  nextEmailFeedCacheRevision,
  readEmailFeedCache,
  readEmailFeedCaches,
  writeEmailFeedCache,
  type EmailFeedCacheStorage,
} from "./feedCache";
import {
  EMAIL_FEED_SCHEMA_VERSION,
  type EmailFeedResponse,
} from "./types";

class MemoryStorage implements EmailFeedCacheStorage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }

  firstKey() {
    return this.key(0);
  }
}

function feed(subject = "Latest message"): EmailFeedResponse {
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
    counts: { inbox: 5, focus: 3, drafts: 1, noise: 2 },
  };
  return {
    schemaVersion: EMAIL_FEED_SCHEMA_VERSION,
    view: "focus",
    mailboxes: [mailbox],
    threads: [
      {
        key: "gmail-work:message-1",
        connectionId: "gmail-work",
        mailbox,
        messageId: "message-1",
        threadId: "thread-1",
        senderName: "Alex",
        senderEmail: "alex@example.com",
        recipients: ["owner@example.com"],
        subject,
        snippet: "A current message",
        receivedAt: "2026-07-28T12:00:00.000Z",
        unread: true,
        starred: false,
        hasAttachments: false,
        direction: "incoming",
        openStatus: null,
        calendarInvite: null,
        action: null,
        draft: null,
      },
    ],
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

test("restores a feed snapshot for the same user, view, and mailbox scope", () => {
  const storage = new MemoryStorage();
  const savedAt = 1_000_000;
  writeEmailFeedCache(
    "user-a",
    "focus",
    null,
    { feed: feed(), limit: 24, savedAt },
    { storage },
  );

  const restored = readEmailFeedCache("user-a", "focus", null, {
    storage,
    now: savedAt + 1_000,
  });
  assert.equal(restored?.feed.threads[0]?.subject, "Latest message");
  assert.equal(restored?.limit, 24);
  assert.equal(restored?.savedAt, savedAt);
});

test("cache revisions expose writes that happened during a refresh", () => {
  assert.equal(emailFeedCacheRevision(null), 0);
  assert.equal(nextEmailFeedCacheRevision(null), 1);
  assert.equal(
    isEmailFeedCacheRevisionCurrent(
      { revision: 4 },
      { revision: 4 },
    ),
    true,
  );
  assert.equal(
    isEmailFeedCacheRevisionCurrent(
      { revision: 4 },
      { revision: 5 },
    ),
    false,
  );
});

test("cache writes preserve revisions used to reject stale refreshes", () => {
  const storage = new MemoryStorage();
  const savedAt = 1_500_000;
  writeEmailFeedCache(
    "user-revision",
    "focus",
    null,
    { feed: feed(), limit: 24, savedAt, revision: 4 },
    { storage },
  );

  const beforeDone = readEmailFeedCache(
    "user-revision",
    "focus",
    null,
    { storage, now: savedAt + 1 },
  );
  assert.equal(beforeDone?.revision, 4);

  writeEmailFeedCache(
    "user-revision",
    "focus",
    null,
    {
      feed: feed("Done was accepted"),
      limit: 24,
      savedAt: savedAt + 2,
      revision: nextEmailFeedCacheRevision(beforeDone),
    },
    { storage },
  );
  const afterDone = readEmailFeedCache(
    "user-revision",
    "focus",
    null,
    { storage, now: savedAt + 3 },
  );
  assert.equal(afterDone?.revision, 5);
  assert.equal(isEmailFeedCacheRevisionCurrent(beforeDone, afterDone), false);
});

test("never returns another signed-in user's email snapshot", () => {
  const storage = new MemoryStorage();
  const savedAt = 2_000_000;
  writeEmailFeedCache(
    "user-a",
    "focus",
    null,
    { feed: feed("Private to A"), limit: 24, savedAt },
    { storage },
  );

  assert.equal(
    readEmailFeedCache("user-b", "focus", null, {
      storage,
      now: savedAt + 1_000,
    }),
    null,
  );
  assert.deepEqual(
    readEmailFeedCaches("user-b", {
      storage,
      now: savedAt + 1_000,
    }),
    [],
  );
});

test("expires snapshots instead of presenting old mail as current", () => {
  const storage = new MemoryStorage();
  const savedAt = 3_000_000;
  writeEmailFeedCache(
    "user-expired",
    "focus",
    null,
    { feed: feed(), limit: 24, savedAt },
    { storage },
  );

  const restored = readEmailFeedCache("user-expired", "focus", null, {
    storage,
    now: savedAt + EMAIL_FEED_CACHE_MAX_AGE_MS + 1,
  });
  assert.equal(restored, null);
  assert.equal(storage.length, 0);
});

test("rejects snapshots from the prior server feed schema", () => {
  const storage = new MemoryStorage();
  const savedAt = 3_500_000;
  writeEmailFeedCache(
    "user-old-feed-schema",
    "focus",
    null,
    { feed: feed(), limit: 24, savedAt },
    { storage },
  );
  clearEmailFeedCache("user-old-feed-schema", null);
  const key = storage.firstKey();
  assert.ok(key);
  const stored = JSON.parse(storage.getItem(key) || "{}") as {
    entry?: { feed?: { schemaVersion?: number } };
  };
  if (stored.entry?.feed) {
    stored.entry.feed.schemaVersion = EMAIL_FEED_SCHEMA_VERSION - 1;
  }
  storage.setItem(key, JSON.stringify(stored));

  assert.equal(
    readEmailFeedCache("user-old-feed-schema", "focus", null, {
      storage,
      now: savedAt + 1,
    }),
    null,
  );
  assert.equal(storage.length, 0);
});

test("keeps mailbox-filtered snapshots separate and restores all valid views", () => {
  const storage = new MemoryStorage();
  const savedAt = 4_000_000;
  writeEmailFeedCache(
    "user-filter",
    "focus",
    null,
    { feed: feed("Unified"), limit: 24, savedAt },
    { storage },
  );
  writeEmailFeedCache(
    "user-filter",
    "focus",
    "gmail-work",
    { feed: feed("Work only"), limit: 48, savedAt: savedAt + 1 },
    { storage },
  );

  const records = readEmailFeedCaches("user-filter", {
    storage,
    now: savedAt + 2,
  });
  assert.equal(records.length, 2);
  assert.equal(records[0]?.connectionId, "gmail-work");
  assert.equal(records[0]?.entry.feed.threads[0]?.subject, "Work only");
  assert.equal(records[1]?.connectionId, null);
});

test("discards malformed browser data without crashing the email screen", () => {
  const storage = new MemoryStorage();
  const savedAt = 5_000_000;
  writeEmailFeedCache(
    "user-corrupt",
    "focus",
    null,
    { feed: feed(), limit: 24, savedAt },
    { storage },
  );
  clearEmailFeedCache("user-corrupt", null);
  const key = storage.firstKey();
  assert.ok(key);
  storage.setItem(key, '{"version":1,"scope":"user-corrupt","entry":{}}');

  assert.equal(
    readEmailFeedCache("user-corrupt", "focus", null, {
      storage,
      now: savedAt + 1,
    }),
    null,
  );
  assert.equal(storage.length, 0);
});
