import assert from "node:assert/strict";
import test from "node:test";
import {
  emailActionBelongsToConversation,
  emailWorkspaceActionAppliesToThread,
  emailWorkspaceOverrideForOperation,
} from "./actionState";

test("Done applies to the whole Gmail conversation", () => {
  assert.equal(emailWorkspaceActionAppliesToThread("move_handled"), true);
  assert.equal(emailWorkspaceActionAppliesToThread("archive"), true);
  assert.equal(emailWorkspaceActionAppliesToThread("read"), true);
  assert.equal(emailWorkspaceActionAppliesToThread("star"), false);
  assert.equal(emailWorkspaceOverrideForOperation("move_handled"), "handled");
});

test("a newer preview message can act on an older action in the same thread", () => {
  assert.equal(
    emailActionBelongsToConversation({
      storedThreadId: "thread-1",
      storedMessageId: "message-old",
      requestedThreadId: "thread-1",
      requestedMessageId: "message-new",
    }),
    true,
  );
});

test("an action cannot be used for a different Gmail conversation", () => {
  assert.equal(
    emailActionBelongsToConversation({
      storedThreadId: "thread-1",
      storedMessageId: "message-1",
      requestedThreadId: "thread-2",
      requestedMessageId: "message-1",
    }),
    false,
  );
});
