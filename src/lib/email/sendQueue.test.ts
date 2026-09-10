import assert from "node:assert/strict";
import test from "node:test";
import {
  emailSendCanUseKeepalive,
  persistPendingEmailSend,
  readCompletedEmailSends,
  readPendingEmailSends,
  recentFailedEmailSends,
  removePendingEmailSend,
  sendEmailDraftDurably,
  type DurableEmailSendRequest,
} from "./sendQueue";
import { EMAIL_DRAFT_HTML_MAX_CHARS } from "./payloadLimits";

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

function request(
  overrides: Partial<DurableEmailSendRequest> = {},
): DurableEmailSendRequest {
  return {
    version: 1,
    userId: "user-1",
    requestId: "request-1",
    connectionId: "mailbox-1",
    draftId: "draft-1",
    actionId: null,
    threadId: "thread-1",
    bodyHtml: "<p>Hello</p>",
    attachments: [],
    confirmAiDraft: false,
    allowSharedGroupTracking: false,
    queuedAt: Date.now(),
    ...overrides,
  };
}

test("pending sends are scoped, deduplicated, and removable", () => {
  const storage = new MemoryStorage();
  persistPendingEmailSend(storage, request());
  persistPendingEmailSend(
    storage,
    request({ draftId: "draft-latest", bodyHtml: "<p>Latest</p>" }),
  );
  persistPendingEmailSend(
    storage,
    request({ userId: "user-2", requestId: "request-2" }),
  );

  assert.deepEqual(
    readPendingEmailSends(storage, "user-1").map((item) => ({
      draftId: item.draftId,
      bodyHtml: item.bodyHtml,
    })),
    [{ draftId: "draft-latest", bodyHtml: null }],
  );
  assert.equal(readPendingEmailSends(storage, "user-2").length, 1);
  removePendingEmailSend(storage, "user-1", "request-1");
  assert.deepEqual(readPendingEmailSends(storage, "user-1"), []);
});

test("large send bodies avoid the browser keepalive size limit", () => {
  assert.equal(emailSendCanUseKeepalive("small"), true);
  assert.equal(emailSendCanUseKeepalive("x".repeat(60_001)), false);
});

test("browser sends bound draft HTML before crossing the function boundary", async () => {
  const originalFetch = globalThis.fetch;
  let sentBody = "";
  globalThis.fetch = async (_input, init) => {
    sentBody = String(init?.body || "");
    return new Response(JSON.stringify({ ok: true, sentThread: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await sendEmailDraftDurably(
      request({
        requestId: "bounded-send-html",
        bodyHtml: "h".repeat(5_000_000),
      }),
      { storage: null },
    );
    const payload = JSON.parse(sentBody) as { bodyHtml: string };
    assert.equal(payload.bodyHtml.length, EMAIL_DRAFT_HTML_MAX_CHARS);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a durable send is executed once and removed only after confirmation", async () => {
  const storage = new MemoryStorage();
  const pending = request({ requestId: "durable-once" });
  let executions = 0;
  let release!: () => void;
  const execute = async () => {
    executions += 1;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { ok: true as const, sentThread: null };
  };

  const first = sendEmailDraftDurably(pending, { execute, storage });
  const second = sendEmailDraftDurably(pending, { execute, storage });
  assert.equal(first, second);
  assert.equal(executions, 1);
  assert.equal(readPendingEmailSends(storage, "user-1").length, 1);

  release();
  await first;
  assert.deepEqual(readPendingEmailSends(storage, "user-1"), []);
  assert.equal(readCompletedEmailSends(storage, "user-1").length, 1);
});

test("an interrupted send stays queued for the global resume bridge", async () => {
  const storage = new MemoryStorage();
  const pending = request({
    userId: "retry-user",
    requestId: "retry-request",
  });

  await assert.rejects(
    sendEmailDraftDurably(pending, {
      execute: async () => {
        throw new TypeError("connection interrupted");
      },
      retryDelaysMs: [],
      storage,
    }),
    /connection interrupted/,
  );
  assert.deepEqual(
    readPendingEmailSends(storage, "retry-user").map(
      (candidate) => candidate.requestId,
    ),
    ["retry-request"],
  );
});

test("a terminal send rejection is not retried after navigation", async () => {
  const storage = new MemoryStorage();
  const pending = request({
    userId: "terminal-user",
    requestId: "terminal-request",
  });

  await assert.rejects(
    sendEmailDraftDurably(pending, {
      execute: async () => {
        throw Object.assign(new Error("confirmation required"), {
          status: 409,
        });
      },
      storage,
    }),
    /confirmation required/,
  );
  assert.deepEqual(readPendingEmailSends(storage, "terminal-user"), []);
  assert.deepEqual(
    recentFailedEmailSends("terminal-user", storage).map((failure) => ({
      requestId: failure.requestId,
      error: failure.error,
    })),
    [
      {
        requestId: "terminal-request",
        error: "confirmation required",
      },
    ],
  );
});
