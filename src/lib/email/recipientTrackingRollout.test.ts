import assert from "node:assert/strict";
import test from "node:test";
import { recipientTrackingRolloutEnabledForUser } from "./recipientTrackingRollout";

test("recipient-specific tracking stays behind an explicit user rollout", () => {
  assert.equal(
    recipientTrackingRolloutEnabledForUser(
      "user-2",
      "user-1,user-2 user-3",
    ),
    true,
  );
  assert.equal(
    recipientTrackingRolloutEnabledForUser("user-4", "user-1,user-2"),
    false,
  );
  assert.equal(
    recipientTrackingRolloutEnabledForUser("user-4", "*"),
    true,
  );
  assert.equal(
    recipientTrackingRolloutEnabledForUser("user-4", ""),
    false,
  );
  assert.equal(
    recipientTrackingRolloutEnabledForUser(
      "user-4",
      "",
      "CharlesMendez@Hotmail.com",
      "other@example.com,charlesmendez@hotmail.com",
    ),
    true,
  );
  assert.equal(
    recipientTrackingRolloutEnabledForUser(
      "user-4",
      "",
      "charlesmendez@hotmail.com",
      "other@example.com",
    ),
    false,
  );
});
