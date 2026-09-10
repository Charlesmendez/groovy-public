import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInternalRouteAuthHeaders,
  verifyInternalRouteAuth,
} from "@/lib/internalRouteAuth";
import { CHAT_MESSAGE_SEND_INTERNAL_SCOPE } from "./internalScopes";

test("Team Chat internal authorization is valid only for its narrow scope", () => {
  const previous = process.env.RELAY_JWT_SECRET;
  process.env.RELAY_JWT_SECRET = "chat-internal-scope-test-secret";
  try {
    const request = new Request("https://groovy.example/api/chat/messages", {
      headers: buildInternalRouteAuthHeaders({
        userId: "user-1",
        scope: CHAT_MESSAGE_SEND_INTERNAL_SCOPE,
      }),
    });
    assert.deepEqual(
      verifyInternalRouteAuth(request, CHAT_MESSAGE_SEND_INTERNAL_SCOPE),
      { userId: "user-1" },
    );
    assert.equal(
      verifyInternalRouteAuth(request, "another-team-chat-operation"),
      null,
    );
  } finally {
    if (previous === undefined) delete process.env.RELAY_JWT_SECRET;
    else process.env.RELAY_JWT_SECRET = previous;
  }
});
