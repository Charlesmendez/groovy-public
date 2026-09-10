import assert from "node:assert/strict";
import test from "node:test";
import {
  EMAIL_DISCOVERY_INTERVAL_MS,
  EMAIL_DISCOVERY_MAX_BACKOFF_MS,
  EMAIL_DISCOVERY_STARTUP_DELAY_MS,
  emailDiscoveryDelayAfterFailure,
  shouldCoalesceEmailFeedRequest,
} from "./backgroundSync";

test("incoming email discovery runs promptly after startup and while active", () => {
  assert.equal(EMAIL_DISCOVERY_STARTUP_DELAY_MS, 2_000);
  assert.equal(EMAIL_DISCOVERY_INTERVAL_MS, 15_000);
});

test("transient discovery failures back off instead of hammering Gmail", () => {
  assert.equal(
    emailDiscoveryDelayAfterFailure({ status: 429, consecutiveFailures: 1 }),
    30_000,
  );
  assert.equal(
    emailDiscoveryDelayAfterFailure({ status: 503, consecutiveFailures: 2 }),
    60_000,
  );
  assert.equal(
    emailDiscoveryDelayAfterFailure({ status: 0, consecutiveFailures: 9 }),
    EMAIL_DISCOVERY_MAX_BACKOFF_MS,
  );
});

test("authentication and mailbox setup errors use the longest backoff", () => {
  for (const status of [401, 403, 409]) {
    assert.equal(
      emailDiscoveryDelayAfterFailure({ status, consecutiveFailures: 1 }),
      EMAIL_DISCOVERY_MAX_BACKOFF_MS,
    );
  }
});

test("overlapping refresh triggers share the active feed request", () => {
  assert.equal(
    shouldCoalesceEmailFeedRequest({
      sameScope: true,
      requestInFlight: true,
      append: false,
      hasCursor: false,
    }),
    true,
  );
  assert.equal(
    shouldCoalesceEmailFeedRequest({
      sameScope: true,
      requestInFlight: true,
      append: true,
      hasCursor: true,
    }),
    false,
  );
  assert.equal(
    shouldCoalesceEmailFeedRequest({
      sameScope: false,
      requestInFlight: true,
      append: false,
      hasCursor: false,
    }),
    false,
  );
});
