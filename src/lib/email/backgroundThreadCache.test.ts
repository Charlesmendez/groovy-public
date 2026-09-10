import assert from "node:assert/strict";
import test from "node:test";
import {
  EMAIL_THREAD_SNAPSHOT_AT_HEADER,
  EMAIL_THREAD_SNAPSHOT_MAX_AGE_MS,
  emailThreadDetailContainsMessage,
  emailThreadSnapshotUrl,
  readEmailBackgroundThreadSnapshot,
} from "./backgroundThreadCache";

function detailPayload() {
  return {
    ok: true,
    thread: {
      summary: {
        key: "conn-1:thread-1",
        connectionId: "conn-1",
        threadId: "thread-1",
      },
      messages: [{ id: "message-1", body: "hello" }],
      replyAll: { to: [], cc: [], subject: "", inReplyTo: null, references: null },
      draft: null,
    },
  };
}

function cacheWith(entries: Record<string, { body: unknown; savedAt: number }>) {
  return {
    open: async () => ({
      match: async (request: RequestInfo | URL) => {
        const key = String(request);
        const entry = entries[key];
        if (!entry) return undefined;
        return {
          ok: true,
          headers: {
            get: (name: string) =>
              name === EMAIL_THREAD_SNAPSHOT_AT_HEADER
                ? String(entry.savedAt)
                : null,
          },
          json: async () => entry.body,
        } as unknown as Response;
      },
    }),
  };
}

// Same default origin the reader resolves outside a browser.
const key = emailThreadSnapshotUrl({
  scope: "user-1",
  connectionId: "conn-1",
  threadId: "thread-1",
});

test("a warmed conversation body is returned for the matching account", async () => {
  const result = await readEmailBackgroundThreadSnapshot({
    scope: "user-1",
    connectionId: "conn-1",
    threadId: "thread-1",
    cacheStorage: cacheWith({ [key]: { body: detailPayload(), savedAt: 1_000 } }),
    now: 2_000,
  });
  assert.ok(result);
  assert.equal(result.detail.summary.threadId, "thread-1");
  assert.equal(result.savedAt, 1_000);
});

test("another account never reads a warmed body", async () => {
  const result = await readEmailBackgroundThreadSnapshot({
    scope: "user-2",
    connectionId: "conn-1",
    threadId: "thread-1",
    cacheStorage: cacheWith({ [key]: { body: detailPayload(), savedAt: 1_000 } }),
    now: 2_000,
  });
  assert.equal(result, null);
});

test("stale bodies are ignored", async () => {
  const result = await readEmailBackgroundThreadSnapshot({
    scope: "user-1",
    connectionId: "conn-1",
    threadId: "thread-1",
    cacheStorage: cacheWith({ [key]: { body: detailPayload(), savedAt: 1_000 } }),
    now: 1_000 + EMAIL_THREAD_SNAPSHOT_MAX_AGE_MS + 1,
  });
  assert.equal(result, null);
});

test("malformed cached payloads are ignored", async () => {
  const result = await readEmailBackgroundThreadSnapshot({
    scope: "user-1",
    connectionId: "conn-1",
    threadId: "thread-1",
    cacheStorage: cacheWith({
      [key]: { body: { ok: true, thread: { summary: {} } }, savedAt: 1_000 },
    }),
    now: 2_000,
  });
  assert.equal(result, null);
});

test("a missing entry resolves to null instead of throwing", async () => {
  const result = await readEmailBackgroundThreadSnapshot({
    scope: "user-1",
    connectionId: "conn-1",
    threadId: "thread-missing",
    cacheStorage: cacheWith({}),
    now: 2_000,
  });
  assert.equal(result, null);
});

test("conversation cache coverage requires the current list message", () => {
  const detail = detailPayload().thread;
  assert.equal(emailThreadDetailContainsMessage(detail, "message-1"), true);
  assert.equal(emailThreadDetailContainsMessage(detail, "message-2"), false);
  assert.equal(emailThreadDetailContainsMessage(detail, null), true);
});
