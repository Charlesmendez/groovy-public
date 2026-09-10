import assert from "node:assert/strict";
import test from "node:test";
import {
  createEmailTrackingToken,
  emailOpenStatusFromTrackingRow,
  emailOpenStatusFromTrackingRows,
  emailTrackingPixelUrl,
  hashEmailTrackingToken,
  recordEmailTrackingOpen,
  shouldCountEmailOpen,
} from "./openTracking";

test("email tracking tokens are opaque and only their hash must be stored", () => {
  const first = createEmailTrackingToken();
  const second = createEmailTrackingToken();
  assert.notEqual(first, second);
  assert.match(first, /^[A-Za-z0-9_-]{32,}$/);
  assert.equal(hashEmailTrackingToken(first).length, 64);
  assert.equal(
    emailTrackingPixelUrl("https://www.gogroovy.ai/email", first),
    `https://www.gogroovy.ai/api/email/open/${first}.gif`,
  );
});
test("open status identifies one recipient but stays honest for groups", () => {
  const single = emailOpenStatusFromTrackingRow({
    metadata: {
      email_tracking_record: true,
      email_tracking_recipients: ["Person@Example.com"],
      email_tracking_first_opened_at: "2026-07-27T18:00:00.000Z",
      email_tracking_open_count: 2,
    },
  });
  assert.equal(single?.attribution, "single_recipient");
  assert.deepEqual(single?.recipients, ["person@example.com"]);
  assert.equal(single?.openCount, 2);

  const group = emailOpenStatusFromTrackingRow({
    metadata: {
      email_tracking_record: true,
      email_tracking_recipients: ["a@example.com", "b@example.com"],
    },
  });
  assert.equal(group?.attribution, "group");
  assert.equal(group?.openedAt, null);
});

test("a send that fell back without a pixel does not claim open tracking", () => {
  assert.equal(
    emailOpenStatusFromTrackingRow({
      metadata: {
        email_tracking_record: true,
        email_tracking_disabled: true,
        email_tracking_recipients: ["person@example.com"],
      },
    }),
    null,
  );
});

test("recipient-specific tracking identifies the exact opener", () => {
  const firstHash = "a".repeat(64);
  const secondHash = "b".repeat(64);
  const metadata = {
    email_tracking_record: true,
    email_tracking_recipients: ["a@example.com", "b@example.com"],
    email_tracking_recipient_token_hashes: [firstHash, secondHash],
    email_tracking_recipient_deliveries: [
      {
        recipient: "a@example.com",
        tokenHash: firstHash,
        state: "sent",
        openCount: 0,
      },
      {
        recipient: "b@example.com",
        tokenHash: secondHash,
        state: "sent",
        openCount: 0,
      },
    ],
  };
  const opened = recordEmailTrackingOpen({
    metadata,
    tokenHash: secondHash,
    now: "2026-07-30T20:00:00.000Z",
  });
  const status = emailOpenStatusFromTrackingRow({ metadata: opened });
  assert.equal(status?.attribution, "recipient_specific");
  assert.equal(status?.openCount, 1);
  assert.deepEqual(
    status?.recipientStatuses?.filter((item) => item.openCount > 0),
    [
      {
        recipient: "b@example.com",
        openedAt: "2026-07-30T20:00:00.000Z",
        lastOpenedAt: "2026-07-30T20:00:00.000Z",
        openCount: 1,
      },
    ],
  );
});

test("isolated recipient records combine without losing another opener", () => {
  const parent = {
    id: "parent-1",
    metadata: {
      email_tracking_record: true,
      email_tracking_recipients: ["a@example.com", "b@example.com"],
      email_tracking_recipient_deliveries: [
        {
          recipient: "a@example.com",
          tokenHash: "a".repeat(64),
          state: "sent",
          openCount: 0,
        },
        {
          recipient: "b@example.com",
          tokenHash: "b".repeat(64),
          state: "sent",
          openCount: 0,
        },
      ],
    },
  };
  const firstRecipient = {
    metadata: {
      email_tracking_record: true,
      email_tracking_recipient_record: true,
      email_tracking_parent_record_id: "parent-1",
      email_tracking_recipients: ["a@example.com"],
      email_tracking_first_opened_at: "2026-07-30T20:00:00.000Z",
      email_tracking_last_opened_at: "2026-07-30T20:01:00.000Z",
      email_tracking_open_count: 2,
    },
  };
  const secondRecipient = {
    metadata: {
      email_tracking_record: true,
      email_tracking_recipient_record: true,
      email_tracking_parent_record_id: "parent-1",
      email_tracking_recipients: ["b@example.com"],
      email_tracking_first_opened_at: "2026-07-30T20:02:00.000Z",
      email_tracking_last_opened_at: "2026-07-30T20:02:00.000Z",
      email_tracking_open_count: 1,
    },
  };
  const status = emailOpenStatusFromTrackingRows([
    secondRecipient,
    parent,
    firstRecipient,
  ]);
  assert.equal(status?.attribution, "recipient_specific");
  assert.equal(status?.openCount, 3);
  assert.equal(status?.openedAt, "2026-07-30T20:00:00.000Z");
  assert.equal(status?.lastOpenedAt, "2026-07-30T20:02:00.000Z");
  assert.deepEqual(
    status?.recipientStatuses?.map((item) => [
      item.recipient,
      item.openCount,
    ]),
    [
      ["a@example.com", 2],
      ["b@example.com", 1],
    ],
  );
});

test("immediate proxy fetches and obvious scanners do not count as opens", () => {
  const sentAt = "2026-07-27T18:00:00.000Z";
  assert.equal(
    shouldCountEmailOpen({
      sentAt,
      nowMs: Date.parse(sentAt) + 1_000,
      userAgent: "Mozilla/5.0",
    }),
    false,
  );
  assert.equal(
    shouldCountEmailOpen({
      sentAt,
      nowMs: Date.parse(sentAt) + 10_000,
      userAgent: "Proofpoint URL Defense",
    }),
    false,
  );
  assert.equal(
    shouldCountEmailOpen({
      sentAt,
      nowMs: Date.parse(sentAt) + 10_000,
      userAgent: "Mozilla/5.0",
    }),
    true,
  );
});
