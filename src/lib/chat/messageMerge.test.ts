import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeChatMessages,
  reconcileChatMessages,
  type MergeableChatMessage,
} from "./messageMerge";

function message(
  id: string,
  createdAt: string,
  metadata: Record<string, unknown> = {},
): MergeableChatMessage {
  return { id, created_at: createdAt, metadata };
}

test("a confirmed message replaces its optimistic counterpart", () => {
  const pending = message("optimistic:client-1", "2026-07-24T10:00:00Z", {
    client_message_id: "client-1",
    client_pending: true,
  });
  const confirmed = message("server-1", "2026-07-24T10:00:01Z", {
    client_message_id: "client-1",
  });

  assert.deepEqual(mergeChatMessages([pending], [confirmed]), [confirmed]);
});

test("reconciliation preserves only optimistic messages absent from the server", () => {
  const existing = message("server-0", "2026-07-24T09:59:00Z");
  const pending = message("optimistic:client-1", "2026-07-24T10:00:00Z", {
    client_message_id: "client-1",
    client_pending: true,
  });

  assert.deepEqual(
    reconcileChatMessages([existing, pending], [existing]),
    [existing, pending],
  );
});

test("reconciliation removes an optimistic duplicate once it is authoritative", () => {
  const pending = message("optimistic:client-1", "2026-07-24T10:00:00Z", {
    client_message_id: "client-1",
    client_pending: true,
  });
  const confirmed = message("server-1", "2026-07-24T10:00:01Z", {
    client_message_id: "client-1",
  });

  assert.deepEqual(
    reconcileChatMessages([pending], [confirmed]),
    [confirmed],
  );
});
