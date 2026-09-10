import assert from "node:assert/strict";
import test from "node:test";
import {
  appendRecipientAddresses,
  mergeVerifiedOwnedRecipientAddresses,
  recipientAddress,
  recipientAddresses,
  removeRecipientAddress,
  mergeAutomaticReplyRecipients,
  sanitizeAutomaticRecipientFields,
} from "./recipients";

test("recipient parsing normalizes and deduplicates address lists", () => {
  assert.deepEqual(
    recipientAddresses(
      "Jessie <Jessie@example.com>; duplicate <jessie@example.com>, next@example.org",
    ),
    ["jessie@example.com", "next@example.org"],
  );
});

test("recipient helpers add and remove one chip without losing the others", () => {
  const added = appendRecipientAddresses("one@example.com", [
    "Two <two@example.com>",
    "one@example.com",
  ]);
  assert.equal(added, "one@example.com, two@example.com");
  assert.equal(
    removeRecipientAddress(added, "ONE@example.com"),
    "two@example.com",
  );
  assert.equal(recipientAddress("Person <person@example.com>"), "person@example.com");
  assert.equal(recipientAddress("not an address"), null);
});

test("automatic recipients remove every owned identity and deduplicate across fields", () => {
  assert.deepEqual(
    sanitizeAutomaticRecipientFields({
      to: [
        "Client <client@example.com>",
        "ME@HIBE.AI",
        "charlesmendez@hotmail.com",
      ],
      cc: [
        "client@example.com",
        "Other <other@example.com>",
        "alias@hibe.ai",
      ],
      bcc: ["OTHER@example.com", "private@example.com"],
      ownedAddresses: [
        "me@hibe.ai",
        "alias@hibe.ai",
        "charlesmendez@hotmail.com",
      ],
    }),
    {
      to: ["client@example.com"],
      cc: ["other@example.com"],
      bcc: ["private@example.com"],
    },
  );
});

test("automatic recipients return empty instead of falling back to self", () => {
  assert.deepEqual(
    sanitizeAutomaticRecipientFields({
      to: ["me@hibe.ai"],
      cc: ["Alias <alias@hibe.ai>"],
      ownedAddresses: ["me@hibe.ai", "alias@hibe.ai"],
    }),
    { to: [], cc: [], bcc: [] },
  );
});

test("verified mailbox identity is merged even when legacy aliases already exist", () => {
  assert.deepEqual(
    mergeVerifiedOwnedRecipientAddresses({
      knownAddresses: [
        "Alias <alias@hibe.ai>",
        ["CHARLESMENDEZ@HOTMAIL.COM"],
      ],
      userAddress: "login@example.com",
      verifiedMailboxAddress: "Carlos@Hibe.ai",
    }),
    [
      "alias@hibe.ai",
      "charlesmendez@hotmail.com",
      "login@example.com",
      "carlos@hibe.ai",
    ],
  );
});

test("automatic reply merging cleans legacy recipients and uses only an external sender fallback", () => {
  assert.deepEqual(
    mergeAutomaticReplyRecipients({
      to: ["me@hibe.ai", "client@example.com"],
      cc: [
        "client@example.com",
        "copy@example.com",
        "alias@hibe.ai",
      ],
      senderAddress: "sender@example.com",
      ownedAddresses: ["me@hibe.ai", "alias@hibe.ai"],
    }),
    {
      to: ["client@example.com"],
      cc: ["copy@example.com"],
    },
  );
  assert.deepEqual(
    mergeAutomaticReplyRecipients({
      to: ["me@hibe.ai"],
      cc: ["copy@example.com"],
      senderAddress: "sender@example.com",
      ownedAddresses: ["me@hibe.ai"],
    }),
    {
      to: ["sender@example.com"],
      cc: ["copy@example.com"],
    },
  );
  assert.deepEqual(
    mergeAutomaticReplyRecipients({
      to: ["me@hibe.ai"],
      senderAddress: "ME@HIBE.AI",
      ownedAddresses: ["me@hibe.ai"],
    }),
    { to: [], cc: [] },
  );
});
