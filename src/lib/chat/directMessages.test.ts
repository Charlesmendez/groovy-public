import assert from "node:assert/strict";
import test from "node:test";
import {
  chatChannelDisplayName,
  directMessageDisplayName,
  isHumanDirectMessageForParticipants,
  isHumanDirectMessageForRecipient,
  selfDirectMessageSlug,
} from "./directMessages";

test("self direct messages use one human member", () => {
  assert.equal(
    isHumanDirectMessageForRecipient({
      currentUserId: "user-1",
      recipientUserId: "user-1",
      memberUserIds: ["user-1"],
      hasAgent: false,
    }),
    true,
  );
  assert.equal(
    isHumanDirectMessageForRecipient({
      currentUserId: "user-1",
      recipientUserId: "user-1",
      memberUserIds: ["user-1", "user-2"],
      hasAgent: false,
    }),
    false,
  );
});

test("teammate direct messages still require both people", () => {
  assert.equal(
    isHumanDirectMessageForRecipient({
      currentUserId: "user-1",
      recipientUserId: "user-2",
      memberUserIds: ["user-1", "user-2"],
      hasAgent: false,
    }),
    true,
  );
  assert.equal(
    isHumanDirectMessageForRecipient({
      currentUserId: "user-1",
      recipientUserId: "user-2",
      memberUserIds: ["user-1"],
      hasAgent: false,
    }),
    false,
  );
});

test("agent conversations never match human direct messages", () => {
  assert.equal(
    isHumanDirectMessageForRecipient({
      currentUserId: "user-1",
      recipientUserId: "user-1",
      memberUserIds: ["user-1"],
      hasAgent: true,
    }),
    false,
  );
});

test("human direct messages can match an exact multi-person participant set", () => {
  assert.equal(
    isHumanDirectMessageForParticipants({
      currentUserId: "user-1",
      participantUserIds: ["user-2", "user-3"],
      memberUserIds: ["user-3", "user-1", "user-2", "user-2"],
      hasAgent: false,
    }),
    true,
  );
  assert.equal(
    isHumanDirectMessageForParticipants({
      currentUserId: "user-1",
      participantUserIds: ["user-2", "user-3"],
      memberUserIds: ["user-1", "user-2"],
      hasAgent: false,
    }),
    false,
  );
});

test("human direct messages display the other participant to each viewer", () => {
  const memberNames = new Map([
    ["user-1", "Carlos"],
    ["user-2", "Daniel"],
  ]);
  assert.equal(
    directMessageDisplayName({
      fallbackName: "Daniel",
      currentUserId: "user-1",
      memberUserIds: ["user-1", "user-2"],
      hasAgent: false,
      memberNames,
    }),
    "Daniel",
  );
  assert.equal(
    directMessageDisplayName({
      fallbackName: "Daniel",
      currentUserId: "user-2",
      memberUserIds: ["user-1", "user-2"],
      hasAgent: false,
      memberNames,
    }),
    "Carlos",
  );
});

test("self notes and agent direct messages keep their intended labels", () => {
  assert.equal(
    directMessageDisplayName({
      fallbackName: "Carlos",
      currentUserId: "user-1",
      memberUserIds: ["user-1"],
      hasAgent: false,
      memberNames: new Map([["user-1", "Carlos"]]),
    }),
    "Notes to self",
  );
  assert.equal(
    directMessageDisplayName({
      fallbackName: "Research Agent",
      currentUserId: "user-1",
      memberUserIds: ["user-1"],
      hasAgent: true,
      memberNames: new Map([["user-1", "Carlos"]]),
    }),
    "Research Agent",
  );
});

test("channel display names prefer a viewer-specific label", () => {
  assert.equal(
    chatChannelDisplayName({
      name: "Daniel",
      display_name: "Carlos",
    }),
    "Carlos",
  );
  assert.equal(chatChannelDisplayName({ name: "launch" }), "launch");
});

test("self direct messages have a stable per-user slug", () => {
  assert.equal(selfDirectMessageSlug(" User-1 "), "notes-user-1");
});
