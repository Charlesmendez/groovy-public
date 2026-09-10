import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInternalRouteAuthHeaders,
  verifyInternalRouteAuth,
} from "@/lib/internalRouteAuth";
import { EMAIL_DRAFT_SEND_INTERNAL_SCOPE } from "./internalScopes";

test("email send internal authorization is bound to its narrow scope", () => {
  const previous = process.env.RELAY_JWT_SECRET;
  process.env.RELAY_JWT_SECRET = "email-send-test-secret";
  try {
    const headers = buildInternalRouteAuthHeaders({
      userId: "user-1",
      scope: EMAIL_DRAFT_SEND_INTERNAL_SCOPE,
    });
    const request = new Request("https://groovy.example/api/email/draft/send", {
      headers,
    });
    assert.deepEqual(
      verifyInternalRouteAuth(request, EMAIL_DRAFT_SEND_INTERNAL_SCOPE),
      { userId: "user-1" },
    );
    assert.equal(verifyInternalRouteAuth(request, "another_scope"), null);
  } finally {
    if (previous === undefined) delete process.env.RELAY_JWT_SECRET;
    else process.env.RELAY_JWT_SECRET = previous;
  }
});
