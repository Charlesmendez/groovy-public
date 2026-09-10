import assert from "node:assert/strict";
import test from "node:test";
import {
  chatWorkspaceActivationState,
  handoffPendingOrchestratorStart,
  keyedOperationPending,
  shouldFollowTimelineGrowth,
  updateKeyedValue,
  updatePendingCount,
} from "./conversationState";

type Composer = {
  draft: string;
  attachments: string[];
};

const EMPTY_COMPOSER: Composer = {
  draft: "",
  attachments: [],
};

test("conversation composer state stays isolated and restores by room", () => {
  let rooms = new Map<string, Composer>();
  rooms = updateKeyedValue(rooms, "daniel", EMPTY_COMPOSER, (composer) => ({
    ...composer,
    draft: "Ahí estoy preguntándole",
    attachments: ["question.png"],
  }));

  assert.deepEqual(rooms.get("compensar"), undefined);
  assert.deepEqual(rooms.get("daniel"), {
    draft: "Ahí estoy preguntándole",
    attachments: ["question.png"],
  });

  rooms = updateKeyedValue(rooms, "compensar", EMPTY_COMPOSER, (composer) => ({
    ...composer,
    draft: "Compensar only",
  }));

  assert.equal(rooms.get("daniel")?.draft, "Ahí estoy preguntándole");
  assert.equal(rooms.get("compensar")?.draft, "Compensar only");
});

test("pending sends are counted and scoped to their originating room", () => {
  let pending = new Map<string, number>();
  pending = updatePendingCount(pending, "compensar", 1);
  pending = updatePendingCount(pending, "compensar", 1);

  assert.equal(keyedOperationPending(pending, "compensar"), true);
  assert.equal(keyedOperationPending(pending, "daniel"), false);

  pending = updatePendingCount(pending, "compensar", -1);
  assert.equal(keyedOperationPending(pending, "compensar"), true);
  pending = updatePendingCount(pending, "compensar", -1);
  assert.equal(keyedOperationPending(pending, "compensar"), false);
});

test("chat reconciles after returning from another workspace", () => {
  let activation = chatWorkspaceActivationState({
    hasActivated: false,
    visible: false,
  });
  assert.deepEqual(activation, {
    hasActivated: false,
    shouldReconcile: false,
  });

  activation = chatWorkspaceActivationState({
    hasActivated: activation.hasActivated,
    visible: true,
  });
  assert.deepEqual(activation, {
    hasActivated: true,
    shouldReconcile: false,
  });

  activation = chatWorkspaceActivationState({
    hasActivated: activation.hasActivated,
    visible: false,
  });
  assert.deepEqual(activation, {
    hasActivated: true,
    shouldReconcile: false,
  });

  activation = chatWorkspaceActivationState({
    hasActivated: activation.hasActivated,
    visible: true,
  });
  assert.deepEqual(activation, {
    hasActivated: true,
    shouldReconcile: true,
  });
});

test("the optimistic Mind card is released only after active work refreshes", async () => {
  const events: string[] = [];
  await handoffPendingOrchestratorStart({
    refreshActiveWork: async () => {
      events.push("refresh-start");
      await Promise.resolve();
      events.push("refresh-committed");
    },
    releasePending: () => events.push("release"),
  });
  assert.deepEqual(events, ["refresh-start", "refresh-committed", "release"]);
});

test("a failed active-work refresh still releases the optimistic Mind card", async () => {
  let released = false;
  await handoffPendingOrchestratorStart({
    refreshActiveWork: async () => {
      throw new Error("offline");
    },
    releasePending: () => {
      released = true;
    },
  });
  assert.equal(released, true);
});

test("timeline growth follows only the live bottom window", () => {
  assert.equal(
    shouldFollowTimelineGrowth({
      sticksToBottom: true,
      hasNewer: false,
      restoringHistory: false,
    }),
    true,
  );
  assert.equal(
    shouldFollowTimelineGrowth({
      sticksToBottom: false,
      hasNewer: false,
      restoringHistory: false,
    }),
    false,
  );
  assert.equal(
    shouldFollowTimelineGrowth({
      sticksToBottom: true,
      hasNewer: true,
      restoringHistory: false,
    }),
    false,
  );
  assert.equal(
    shouldFollowTimelineGrowth({
      sticksToBottom: true,
      hasNewer: false,
      restoringHistory: true,
    }),
    false,
  );
});
